/**
 * A hand-written OpenAPI 3.1 description of the public surface.
 *
 * Kept next to the routes rather than generated so that the documented
 * behaviours (409 on slot collision, 401 on bad signature, duplicate outcomes)
 * are part of the contract a reviewer can read without running anything.
 */
const spec = {
  openapi: '3.1.0',
  info: {
    title: 'AppointmentOS API',
    version: '1.0.0',
    description:
      'Multi-tenant appointment booking and staff scheduling. Public endpoints are unauthenticated but rate limited; dashboard endpoints require a session cookie and are scoped to the caller’s organisation; the payment webhook is authenticated by HMAC signature.',
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'public', description: 'Customer booking surface — no session required' },
    { name: 'dashboard', description: 'Staff surface — session cookie required' },
    { name: 'webhooks', description: 'Inbound provider callbacks — signature required' },
    { name: 'ops', description: 'Operational probes' },
  ],
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'aos_session' },
      webhookSignature: { type: 'apiKey', in: 'header', name: 'stripe-signature' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', examples: ['conflict', 'unauthorized', 'rate_limited'] },
              message: { type: 'string' },
              details: { type: ['object', 'array', 'null'] },
            },
            required: ['code', 'message'],
          },
        },
      },
      Slot: {
        type: 'object',
        properties: {
          startsAt: { type: 'string', format: 'date-time', description: 'UTC instant' },
          endsAt: { type: 'string', format: 'date-time' },
          label: { type: 'string', examples: ['09:00'], description: 'Local wall clock' },
          staffId: { type: 'string' },
          staffName: { type: 'string' },
          remainingSeats: { type: 'integer', minimum: 0 },
        },
      },
      Availability: {
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date' },
          timezone: { type: 'string', examples: ['America/New_York'] },
          serviceId: { type: 'string' },
          durationMin: { type: 'integer' },
          reasonIfEmpty: { type: ['string', 'null'] },
          staff: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                staffId: { type: 'string' },
                staffName: { type: 'string' },
                color: { type: 'string' },
                slots: { type: 'array', items: { $ref: '#/components/schemas/Slot' } },
              },
            },
          },
        },
      },
      Hold: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'Opaque hold token, valid for slotHoldMinutes' },
          expiresAt: { type: 'string', format: 'date-time' },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          holdMinutes: { type: 'integer' },
        },
      },
      BookingRequest: {
        type: 'object',
        required: ['orgSlug', 'serviceId', 'staffId', 'startsAt', 'customer'],
        properties: {
          orgSlug: { type: 'string' },
          serviceId: { type: 'string' },
          staffId: { type: 'string' },
          startsAt: { type: 'string', format: 'date-time' },
          holdToken: { type: 'string', description: 'Optional: converts a hold instead of taking a new slot' },
          idempotencyKey: {
            type: 'string',
            description: 'Repeating the same key returns the original appointment instead of creating another',
          },
          notes: { type: 'string', maxLength: 1000 },
          seats: { type: 'integer', minimum: 1 },
          customer: {
            type: 'object',
            required: ['name', 'email'],
            properties: {
              name: { type: 'string', minLength: 2 },
              email: { type: 'string', format: 'email' },
              phone: { type: ['string', 'null'] },
              timezone: { type: 'string' },
            },
          },
        },
      },
      Booking: {
        type: 'object',
        properties: {
          appointment: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: {
                type: 'string',
                enum: ['PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
              },
              startsAt: { type: 'string', format: 'date-time' },
              endsAt: { type: 'string', format: 'date-time' },
              timezone: { type: 'string' },
            },
          },
          payment: {
            type: ['object', 'null'],
            properties: {
              providerRef: { type: 'string' },
              clientSecret: { type: 'string' },
              amountCents: { type: 'integer', description: 'Minor units. Never a float.' },
            },
          },
          requiresPayment: { type: 'boolean' },
          manageToken: { type: 'string', description: 'Signed link token for the customer’s manage page' },
          replayed: { type: 'boolean', description: 'true when an idempotency key matched an existing booking' },
        },
      },
      WebhookAck: {
        type: 'object',
        properties: {
          received: { type: 'boolean' },
          outcome: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['processed', 'duplicate', 'skipped', 'deferred', 'failed'] },
              detail: { type: 'string' },
            },
          },
        },
      },
    },
  },
  paths: {
    '/api/public/org/{slug}': {
      get: {
        tags: ['public'],
        summary: 'Booking page bootstrap',
        description: 'The organisation, its default location, active services and qualified staff.',
        parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Organisation and catalogue' },
          404: { description: 'Unknown slug', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/public/availability': {
      get: {
        tags: ['public'],
        summary: 'Bookable times for a local date',
        description:
          'Returns slots in the location time zone. A slot is only returned when the whole block (duration plus buffers) fits inside a working window, does not overlap an existing appointment, an active hold or an occupancy tick, and is beyond the 30-minute lead time.',
        parameters: [
          { name: 'org', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'serviceId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'staffId', in: 'query', schema: { type: 'string' } },
          { name: 'mode', in: 'query', schema: { type: 'string', enum: ['day', 'week'] } },
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 21 } },
        ],
        responses: {
          200: { description: 'Availability', content: { 'application/json': { schema: { $ref: '#/components/schemas/Availability' } } } },
          429: { description: 'Rate limited' },
        },
      },
    },
    '/api/public/holds': {
      post: {
        tags: ['public'],
        summary: 'Hold a slot during checkout',
        description:
          'Creates a temporary reservation with its own occupancy ticks. The slot disappears from availability immediately and returns automatically when the hold expires.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orgSlug', 'serviceId', 'staffId', 'startsAt'],
                properties: {
                  orgSlug: { type: 'string' },
                  serviceId: { type: 'string' },
                  staffId: { type: 'string' },
                  startsAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Hold created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Hold' } } } },
          409: { description: 'Slot already taken (lost the race)' },
          429: { description: 'Too many holds from this address' },
        },
      },
    },
    '/api/public/bookings': {
      post: {
        tags: ['public'],
        summary: 'Create a booking',
        description:
          'Re-validates availability inside a transaction, then writes occupancy ticks. Exactly one of two concurrent requests can succeed; the loser receives 409. A repeated idempotencyKey returns the original booking with replayed=true.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BookingRequest' } } },
        },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Booking' } } } },
          200: { description: 'Replayed — existing booking returned' },
          409: { description: 'Slot taken', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          422: { description: 'Validation failed' },
        },
      },
    },
    '/api/public/payments/confirm': {
      post: {
        tags: ['public'],
        summary: 'Mock checkout (demo only)',
        description:
          'Simulates the provider confirming a payment intent by emitting a signed webhook to /api/webhooks/payments. It never confirms the booking itself. Pass the same eventId twice to demonstrate duplicate-delivery handling.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['providerRef'],
                properties: {
                  providerRef: { type: 'string' },
                  outcome: { type: 'string', enum: ['succeed', 'fail'] },
                  eventId: { type: 'string', description: 'Reuse to replay the same delivery' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Webhook outcome', content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookAck' } } } },
        },
      },
    },
    '/api/public/manage/{token}': {
      get: {
        tags: ['public'],
        summary: 'Read a booking via its signed link',
        description: 'The token is an HMAC over appointmentId and the customer email; it cannot be guessed.',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Appointment, cancellation policy and availability for rescheduling' },
          403: { description: 'Invalid or mismatched token' },
        },
      },
      post: {
        tags: ['public'],
        summary: 'Cancel or reschedule',
        description:
          'Cancel applies the cancellation policy and queues any refund. Reschedule reserves the new slot before releasing the old one, so a failed move leaves the booking untouched.',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { type: 'object', required: ['action'], properties: { action: { const: 'cancel' }, reason: { type: 'string' } } },
                  {
                    type: 'object',
                    required: ['action', 'startsAt'],
                    properties: {
                      action: { const: 'reschedule' },
                      startsAt: { type: 'string', format: 'date-time' },
                      reason: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          200: { description: 'Applied' },
          409: { description: 'New slot unavailable — original booking unchanged' },
        },
      },
    },
    '/api/webhooks/payments': {
      post: {
        tags: ['webhooks'],
        summary: 'Payment provider callback',
        description:
          'Verifies the HMAC signature (including a 5-minute timestamp tolerance) before parsing. Duplicate deliveries return 200 with outcome.status="duplicate" and change nothing. Stale failure events are skipped. Unknown payments are stored and retried rather than dropped.',
        security: [{ webhookSignature: [] }],
        responses: {
          200: { description: 'Accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookAck' } } } },
          401: { description: 'Signature verification failed' },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['dashboard'],
        summary: 'Sign in',
        description: 'Sets an httpOnly session cookie. Rate limited to 10 attempts per 5 minutes per address.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
              },
            },
          },
        },
        responses: { 200: { description: 'Session created' }, 401: { description: 'Bad credentials' }, 429: { description: 'Rate limited' } },
      },
    },
    '/api/dashboard/summary': {
      get: {
        tags: ['dashboard'],
        summary: 'Overview metrics',
        description: 'Today’s schedule, 30-day revenue and completion trends, utilisation, queue depth and recent audit entries.',
        security: [{ sessionCookie: [] }],
        responses: { 200: { description: 'Summary' }, 401: { description: 'Not signed in' } },
      },
    },
    '/api/dashboard/appointments': {
      get: {
        tags: ['dashboard'],
        summary: 'List appointments (org-scoped, paginated)',
        security: [{ sessionCookie: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'staffId', in: 'query', schema: { type: 'string' } },
          { name: 'take', in: 'query', schema: { type: 'integer', maximum: 100 } },
          { name: 'skip', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Rows and total' }, 401: { description: 'Not signed in' } },
      },
    },
    '/api/dashboard/appointments/{id}/cancel': {
      post: {
        tags: ['dashboard'],
        summary: 'Cancel (manager role required)',
        description: 'Applies the cancellation policy, queues any refund, releases occupancy and notifies the customer.',
        security: [{ sessionCookie: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Cancelled, with refundCents and feeCents' },
          403: { description: 'Insufficient role' },
          404: { description: 'Not in this organisation' },
        },
      },
    },
    '/api/dashboard/appointments/{id}/reschedule': {
      post: {
        tags: ['dashboard'],
        summary: 'Reschedule (manager role required)',
        security: [{ sessionCookie: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Moved' }, 409: { description: 'Slot unavailable' } },
      },
    },
    '/api/dashboard/worker': {
      post: {
        tags: ['ops'],
        summary: 'Drain the job queue once',
        description: 'Runs the same code path as the standalone worker, for demos without a second terminal.',
        security: [{ sessionCookie: [] }],
        responses: { 200: { description: 'Number of jobs processed' } },
      },
    },
    '/api/health': {
      get: {
        tags: ['ops'],
        summary: 'Readiness probe',
        description: 'Executes a real query against the database and reports queue depth and enabled integrations.',
        responses: { 200: { description: 'Healthy' } },
      },
    },
  },
} as const

export function GET() {
  return Response.json(spec, {
    headers: { 'cache-control': 'public, max-age=300' },
  })
}
