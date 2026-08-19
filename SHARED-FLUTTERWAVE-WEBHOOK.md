# WYWHOT + existing MedWord Flutterwave webhook

WYWHOT must not replace the Flutterwave account webhook currently used by MedWord.

## Routing rule

WYWHOT Pro payments are identifiable by either:

- reference prefix: `WYH-`
- charge metadata: `meta.app === "WYWHOT"`

When the existing MedWord webhook is supplied, add a WYWHOT branch to that webhook:

1. Verify `flutterwave-signature` over the raw request body.
2. Parse the event only after signature verification.
3. If the reference starts with `WYH-` or `data.meta.app === "WYWHOT"`, route the event to the WYWHOT activation logic.
4. Re-query the Flutterwave charge using the server-side v4 API.
5. Require `succeeded` status and exact reference/amount/currency match against `pro_orders`.
6. Upsert `payment_events` using the event id as the unique key.
7. Activate `pro_entitlements` for 30 days.
8. The activation code is idempotent: a webhook retry or redirect verification of the same paid order must not grant another 30 days.
9. Otherwise leave the existing MedWord processing unchanged.

Until this merge is made, leave the Flutterwave account webhook pointing to the existing MedWord endpoint. The WYWHOT `/api/flutterwave/webhook.js` route is retained for isolated testing and is not the account-level webhook configuration.
