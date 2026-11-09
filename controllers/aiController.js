const Medicine = require('../models/Medicine');
const Inventory = require('../models/Inventory');
const Pharmacy = require('../models/Pharmacy');
const asyncHandler = require('../utils/asyncHandler');
const { parseRadius } = require('../utils/radius');

const {
  visionJson,
  OpenRouterError,
} = require('../services/openrouter');

const {
  hashPrescription,
} = require('../services/prescriptionIntegrity');

const {
  reviewPrescriptionImage,
} = require('../services/prescriptionAuthenticity');

const {
  minimaxReview,
} = require('../services/minimaxReviewer');

/* =========================================================
   AVAILABILITY
========================================================= */

const AVAILABLE = {
  $or: [
    { status: 'in_stock' },
    {
      status: { $exists: false },
      stock: { $gt: 0 },
    },
  ],
};

/* =========================================================
   IMAGE + RATE LIMITS
========================================================= */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

const RATE_LIMIT = {
  max: 20,
  windowMs: 60 * 60 * 1000,
};

const hits = new Map();

function rateLimited(userId) {
  const now = Date.now();

  const fresh = (hits.get(userId) || []).filter(
    (time) => now - time < RATE_LIMIT.windowMs
  );

  if (fresh.length >= RATE_LIMIT.max) {
    return true;
  }

  fresh.push(now);
  hits.set(userId, fresh);

  return false;
}

/* =========================================================
   PRESCRIPTION TRANSCRIPTION PROMPTS
========================================================= */

const SYSTEM = `
You are a careful pharmacy prescription-reading assistant.

Your primary job is to transcribe what is actually visible in a photograph
of a medical prescription.

IMPORTANT RULES:

- Never invent a medicine that is not visible on the page.
- Never recommend a substitute medicine.
- Never change a prescribed dosage.
- Never recommend increasing, decreasing, starting, or stopping a medicine.
- Never diagnose a medical condition.
- Preserve written dosage instructions as accurately as possible.
- When handwriting is uncertain, lower the confidence instead of guessing confidently.
- General safety information must remain informational.
- Age-related warnings are only signals for pharmacist or doctor verification.
- Never claim that a dose is definitely safe or unsafe based only on the image.
- Return JSON only.
`;

const PROMPT = `
Read this prescription image.

Return JSON with exactly this structure:

{
  "isPrescription": boolean,
  "notAPrescriptionReason": string | null,

  "doctorName": string | null,
  "clinicName": string | null,
  "patientName": string | null,
  "date": string | null,

  "medicines": [
    {
      "name": "generic or salt name as best you can reliably read it",
      "brand": "brand name if clearly printed, otherwise null",
      "strength": "e.g. 500mg, 10ml, otherwise null",
      "form": "tablet | capsule | syrup | injection | cream | drops | other | null",
      "dosage": "instructions exactly as written, otherwise null",
      "duration": "e.g. 5 days, otherwise null",
      "quantity": "total units written, otherwise null",
      "confidence": "high | medium | low",

      "safetyInfo": [
        "short general safety information"
      ],

      "ageCaution": {
        "needsReview": boolean,
        "message": "short age-related caution or null"
      }
    }
  ],

  "notes": [
    "other instructions actually written on the prescription"
  ]
}

PATIENT AGE:

{{PATIENT_AGE}}

Rules:

1. If the image is not a prescription:
   - set isPrescription to false
   - briefly explain why in notAPrescriptionReason
   - return medicines as []

2. Transcribe every medicine line you can reliably identify.

3. Do not invent unreadable medicine names.

4. If a medicine line is too unclear to identify, do not guess a medicine.

5. Return null for fields that cannot be reliably read.

6. Preserve dosage instructions as written.

7. Dosage-form abbreviations such as Tab., Cap., Syp., Inj. and Oint.
   belong in form and are not brand names.

8. safetyInfo must only contain concise general safety information.

9. Do not provide personalized medical advice.

10. ageCaution.needsReview may be true when age makes professional
    verification especially important, including:
    - pediatric patients
    - older patients
    - medicines commonly requiring age-specific dosing
    - unclear strength or dosage
    - formulations where age matters
    - medicines where age-related professional verification is important

11. If ageCaution.needsReview is true, the message should clearly tell
    the user to confirm the dose with a pharmacist or doctor.

12. Never state that a dose is definitely too high, too low, safe, or unsafe.

13. Return JSON only.
`;

/* =========================================================
   CLEANING
========================================================= */

const escapeRe = (value) =>
  String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

const PLACEHOLDER =
  /^(n\.?\/?a\.?|none|null|nil|unknown|undefined|not\s*(specified|mentioned|available|given|provided|listed|written|legible|clear)|illegible|-{1,3}|\?+)$/i;

const clean = (value) => {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const text = value
    .trim()
    .replace(/[.,;]+$/, '');

  return !text || PLACEHOLDER.test(text)
    ? null
    : text;
};

const CONFIDENCES = [
  'high',
  'medium',
  'low',
];

function cleanSafetyInfo(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(clean)
    .filter(Boolean)
    .slice(0, 6);
}

function cleanAgeCaution(value, age) {
  if (
    age === null ||
    !value ||
    typeof value !== 'object' ||
    value.needsReview !== true
  ) {
    return {
      needsReview: false,
      message: null,
    };
  }

  return {
    needsReview: true,

    message:
      clean(value.message) ||
      'Age-related dosing should be verified. Please confirm the dose with a pharmacist or doctor.',
  };
}

/* =========================================================
   CATALOG MATCHING
========================================================= */

async function findCatalogMatches(med) {
  const terms = [
    clean(med.name),
    clean(med.brand),
  ].filter(Boolean);

  if (!terms.length) {
    return [];
  }

  const firstWords = terms
    .map((term) => term.split(/\s+/)[0])
    .filter(
      (word) =>
        word &&
        word.length >= 4
    );

  for (const group of [
    terms,
    firstWords,
  ]) {
    if (!group.length) {
      continue;
    }

    const or = group.flatMap(
      (term) => {
        const regex = {
          $regex: escapeRe(term),
          $options: 'i',
        };

        return [
          { name: regex },
          { brand: regex },
          { sku: regex },
        ];
      }
    );

    const found = await Medicine.find({
      $or: or,
    }).limit(5);

    if (found.length) {
      return found;
    }
  }

  return [];
}

/* =========================================================
   PHARMACY OFFERS
========================================================= */

async function offersForSkus(
  skus,
  {
    lat,
    lon,
    radius,
  }
) {
  if (!skus.length) {
    return [];
  }

  const query = {
    sku: {
      $in: skus,
    },

    ...AVAILABLE,
  };

  if (
    !Number.isNaN(lat) &&
    !Number.isNaN(lon)
  ) {
    const nearbyIds = await Pharmacy.find({
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [
              lon,
              lat,
            ],
          },

          $maxDistance: radius,
        },
      },
    }).distinct('_id');

    if (!nearbyIds.length) {
      return [];
    }

    query.pharmacy = {
      $in: nearbyIds,
    };
  }

  const rows = await Inventory.find(query)
    .populate('pharmacy')
    .limit(200);

  return rows
    .filter(
      (row) => row.pharmacy
    )
    .map(
      (row) => ({
        sku: row.sku,

        price:
          row.price ?? null,

        status:
          row.status,

        lastUpdatedAt:
          row.lastUpdatedAt,

        pharmacy: {
          _id:
            row.pharmacy._id,

          name:
            row.pharmacy.name,

          address:
            row.pharmacy.address,

          phone:
            row.pharmacy.phone,

          rating:
            row.pharmacy.rating,

          hours:
            row.pharmacy.hours,

          mapsLink:
            row.pharmacy.mapsLink,

          location:
            row.pharmacy.location,
        },
      })
    );
}

/* =========================================================
   VERIFICATION RESULT
========================================================= */

function buildVerification(
  visualReview,
  minimaxResult
) {
  if (
    visualReview?.classification ===
    'needs_manual_review'
  ) {
    return {
      status:
        'needs_manual_review',

      label:
        'Manual review recommended',
    };
  }

  if (
    minimaxResult?.available === true &&
    minimaxResult.assessment ===
      'review_recommended'
  ) {
    return {
      status:
        'needs_manual_review',

      label:
        'Manual review recommended',
    };
  }

  if (
    visualReview?.classification ===
    'likely_clinical_document'
  ) {
    return {
      status:
        'likely_clinical_document',

      label:
        'No obvious visual concerns detected',
    };
  }

  return {
    status:
      'unable_to_determine',

    label:
      'Unable to verify from image alone',
  };
}

/* =========================================================
   POST /api/v1/ai/prescription
========================================================= */

exports.readPrescription =
  asyncHandler(
    async (req, res) => {
      /* -------------------------
         RATE LIMIT
      ------------------------- */

      if (
        rateLimited(
          String(req.user._id)
        )
      ) {
        return res
          .status(429)
          .json({
            message:
              `Scan limit reached (${RATE_LIMIT.max}/hour). Try again later.`,
          });
      }

      /* -------------------------
         IMAGE VALIDATION
      ------------------------- */

      const {
        image,
      } = req.body || {};

      if (
        typeof image !== 'string' ||
        !image.startsWith('data:')
      ) {
        return res
          .status(400)
          .json({
            message:
              'image must be a base64 data URL',
          });
      }

      const match =
        /^data:([^;,]+);base64,(.+)$/s.exec(
          image
        );

      if (!match) {
        return res
          .status(400)
          .json({
            message:
              'Malformed image data URL',
          });
      }

      const [
        ,
        mime,
        b64,
      ] = match;

      if (
        !ALLOWED_TYPES.includes(
          mime.toLowerCase()
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              'Image must be JPEG, PNG or WebP',
          });
      }

      if (
        Math.floor(
          (b64.length * 3) / 4
        ) >
        MAX_IMAGE_BYTES
      ) {
        return res
          .status(413)
          .json({
            message:
              'Image is too large (max 8 MB)',
          });
      }

      /* -------------------------
         AGE
      ------------------------- */

      const rawAge =
        req.body.age;

      let age = null;

      if (
        rawAge !== undefined &&
        rawAge !== null &&
        rawAge !== ''
      ) {
        age =
          Number(rawAge);

        if (
          !Number.isInteger(age) ||
          age < 0 ||
          age > 120
        ) {
          return res
            .status(400)
            .json({
              message:
                'Age must be a whole number between 0 and 120',
            });
        }
      }

      /* -------------------------
         LOCATION
      ------------------------- */

      const lat =
        parseFloat(
          req.query.lat ??
          req.body.lat
        );

      const lon =
        parseFloat(
          req.query.lon ??
          req.body.lon
        );

      const radius =
        parseRadius(
          req.body.radius ||
          req.query.radius
        );

      /* -------------------------
         SHA-256 FINGERPRINT
      ------------------------- */

      const integrity =
        hashPrescription(image);

      /* -------------------------
         PRIMARY AI SCAN
      ------------------------- */

      const prompt =
        PROMPT.replace(
          '{{PATIENT_AGE}}',

          age === null
            ? 'Not provided. Do not make age-specific assumptions.'
            : `${age} years`
        );

      let reading;

      try {
        reading =
          await visionJson({
            dataUrl: image,
            system: SYSTEM,
            prompt,
            maxTokens: 5000,
            responseType:
              'prescription',
          });
      } catch (err) {
        if (
          err instanceof
          OpenRouterError
        ) {
          return res
            .status(
              err.status || 502
            )
            .json({
              message:
                err.message,
            });
        }

        throw err;
      }

      if (
        reading.isPrescription ===
        false
      ) {
        return res
          .status(422)
          .json({
            message:
              reading
                .notAPrescriptionReason ||
              "That image doesn't look like a prescription.",
          });
      }

      /* -------------------------
         VISUAL AUTHENTICITY REVIEW
      ------------------------- */

      let visualReview;

      try {
        visualReview =
          await reviewPrescriptionImage(
            image
          );
      } catch (error) {
        console.error(
          'Prescription visual review failed:',
          error.message
        );

        visualReview = {
          available: false,

          classification:
            'unable_to_determine',

          confidence: 'low',

          signals: [],

          digitalManipulationSignals:
            [],

          manualReviewRecommended:
            false,

          error:
            'Visual review unavailable',
        };
      }

      /* -------------------------
         MINIMAX REVIEW
      ------------------------- */

      let minimaxResult;

      try {
        minimaxResult =
          await minimaxReview({
            prescription: reading,
            visualReview,
          });
      } catch (error) {
        console.error(
          'MiniMax review failed:',
          error.message
        );

        minimaxResult = {
          available: false,
          reason:
            'MiniMax review unavailable',
        };
      }

      /* -------------------------
         CLEAN MEDICINES
      ------------------------- */

      const extracted = (
        Array.isArray(
          reading.medicines
        )
          ? reading.medicines
          : []
      )
        /*
         * Preserve the original tested behaviour.
         *
         * "unknown", "N/A", etc. become null through clean().
         * A row with neither a usable name nor brand is dropped.
         */
        .filter(
          (med) =>
            med &&
            typeof med === 'object' &&
            (
              clean(med.name) ||
              clean(med.brand)
            )
        )
        .slice(0, 25);

      /* -------------------------
         MATCH + PRICE
      ------------------------- */

      const items = [];

      for (
        const med of extracted
      ) {
        const matches =
          await findCatalogMatches(
            med
          );

        const offers =
          await offersForSkus(
            matches.map(
              (medicine) =>
                medicine.sku
            ),
            {
              lat,
              lon,
              radius,
            }
          );

        offers.sort(
          (first, second) =>
            (
              first.price ??
              Infinity
            ) -
            (
              second.price ??
              Infinity
            )
        );

        const priced =
          offers.filter(
            (offer) =>
              typeof offer.price ===
              'number'
          );

        const ageCaution =
          cleanAgeCaution(
            med.ageCaution,
            age
          );

        items.push({
          prescribed: {
            name:
              clean(med.name),

            brand:
              clean(med.brand),

            strength:
              clean(
                med.strength
              ),

            form:
              clean(
                med.form
              ),

            dosage:
              clean(
                med.dosage
              ),

            duration:
              clean(
                med.duration
              ),

            quantity:
              clean(
                med.quantity
              ),

            confidence:
              CONFIDENCES.includes(
                String(
                  med.confidence
                ).toLowerCase()
              )
                ? String(
                    med.confidence
                  ).toLowerCase()
                : 'medium',

            safetyInfo:
              cleanSafetyInfo(
                med.safetyInfo
              ),

            ageCaution,
          },

          catalog:
            matches.map(
              (medicine) => ({
                _id:
                  medicine._id,

                sku:
                  medicine.sku,

                name:
                  medicine.name,

                brand:
                  medicine.brand,

                form:
                  medicine.form,

                strength:
                  medicine.strength,

                mrp:
                  medicine.price ??
                  null,

                description:
                  medicine.description ||
                  null,

                prescriptionRequired:
                  medicine.prescriptionRequired,
              })
            ),

          bestPrice:
            priced.length
              ? priced[0].price
              : null,

          offers:
            offers.slice(
              0,
              10
            ),

          availableNearby:
            offers.length,
        });
      }

      /* -------------------------
         TOTALS
      ------------------------- */

      const estimatedTotal =
        items.reduce(
          (sum, item) =>
            sum +
            (
              item.bestPrice ??
              item.catalog[0]
                ?.mrp ??
              0
            ),
          0
        );

      const unmatched =
        items.filter(
          (item) =>
            !item.catalog.length
        ).length;

      const ageWarnings =
        items.filter(
          (item) =>
            item.prescribed
              .ageCaution
              ?.needsReview
        ).length;

      /* -------------------------
         COMBINE VERIFICATION
      ------------------------- */

      const verificationSummary =
        buildVerification(
          visualReview,
          minimaxResult
        );

      /* -------------------------
         RESPONSE
      ------------------------- */

      return res.json({
        prescription: {
          doctorName:
            clean(
              reading.doctorName
            ),

          clinicName:
            clean(
              reading.clinicName
            ),

          patientName:
            clean(
              reading.patientName
            ),

          date:
            clean(
              reading.date
            ),

          notes:
            (
              Array.isArray(
                reading.notes
              )
                ? reading.notes
                : []
            )
              .map(clean)
              .filter(Boolean),
        },

        patient: {
          age,
        },

        items,

        estimatedTotal,

        unmatched,

        ageWarnings,

        searchedNear:
          Number.isNaN(lat) ||
          Number.isNaN(lon)
            ? null
            : {
                lat,
                lon,
                radius,
              },

        verification: {
          status:
            verificationSummary.status,

          label:
            verificationSummary.label,

          integrity: {
            algorithm:
              integrity.algorithm,

            hash:
              integrity.hash,

            mime:
              integrity.mime,

            bytes:
              integrity.bytes,
          },

          visualReview,

          minimaxReview:
            minimaxResult,

          disclaimer:
            'Image analysis cannot prove whether a prescription was genuinely issued by a doctor or digitally created. Stronger verification requires trusted provider data, signed prescription IDs, QR signatures, or manual verification.',
        },

        model:
          reading._model ||
          null,

        disclaimer:
          'AI transcription can contain errors. Do not use this scan to change or self-adjust a medicine dose. Always compare the result with the original prescription and confirm unclear or age-related dosing with a pharmacist or doctor. Prices are indicative.',
      });
    }
  );