# Database Migration Manifest

Apply migrations in ascending order, from 0001 through 0023.

Do not edit or replace a released migration. Make future schema changes in a new, consecutively numbered migration.

| Order | Version | Filename | SHA-256 |
|---:|---:|---|---|
| 1 | 0001 | `0001_initial_schema.sql` | `37974475cbcaaf4d0f82e818ccc66808e3095843c6af3ab34738326b9f5a3963` |
| 2 | 0002 | `0002_auth_previews_and_uploads.sql` | `aa76b1861fdeb48257a04225775c635cf4dfaa227df2682ef80039f7f96362f8` |
| 3 | 0003 | `0003_local_test_payments.sql` | `53e660dd76d78d282598af2f337e30b44d4dd604fe595d39cbc56843c1939da3` |
| 4 | 0004 | `0004_payment_webhook_recovery.sql` | `0f7701530fb44ae5651fe999c18d400f8c87056b9b6f086aacdd76acdd6620c4` |
| 5 | 0005 | `0005_publication_delivery.sql` | `c85cf4945347ea8d284d2543e80c13a0b79970d0328cce2256fbf7d1d26b4c75` |
| 6 | 0006 | `0006_storage_entitlements.sql` | `6a44bcf5ee4d1d9634d49c15c6ea87d8d0d91d18d0a915528f261f116b347000` |
| 7 | 0007 | `0007_love_letter_photos.sql` | `d0a2823fa38fe4bbcad7204a8cb76018b0f7673659e316c87f0eff591d4563be` |
| 8 | 0008 | `0008_scheduled_maintenance.sql` | `ecc9d2e1c98b0effb8cd61c2bb041b65f24b24d3acbff2bdb70fed54dddd1665` |
| 9 | 0009 | `0009_fulfillment_recovery_leases.sql` | `6325fec46e3c4d5330f97fa8a19f769051438c3ca90a811b205b301b3d85e25a` |
| 10 | 0010 | `0010_asset_upload_leases.sql` | `50bea1ad33d6f300e567b9de351e6991b4579529a7a228ed2ddcf937a612ecd7` |
| 11 | 0011 | `0011_asset_reference_and_upload_attempts.sql` | `3c98ce68a5bed2db0b88a63a7b926f20c2a124ded8585b7e196487a44852c113` |
| 12 | 0012 | `0012_lifecycle_retention_and_upload_recovery.sql` | `7078974888b7038439d98f8c355ea8a7761bf6b695292299730030cdc50a6798` |
| 13 | 0013 | `0013_publication_derivative_operations.sql` | `c74ef1dc1220b9314999eee17e87e75e71a8a6af252603479db75b951056f1a7` |
| 14 | 0014 | `0014_derivative_provider_success_reconciliation.sql` | `e0a3cdc6672241adee3df11f6bf7fd30b7e9ef98b00be72e1d9bbb5ee25fbd83` |
| 15 | 0015 | `0015_payment_settlement_evidence.sql` | `5e498cfc901c3b205aa865e894a3d3adc54c7a92a7981596b48c83ae33c5aed4` |
| 16 | 0016 | `0016_sepay_api_v2_reconciliation.sql` | `19cc2908d97cced4d5a94ce070778fa47ca45fb2f82d2b2ac96855b74641cafe` |
| 17 | 0017 | `0017_sepay_api_reconciliation_continuation.sql` | `418e57a5698e42201dab158e723d00852b8dea7d3d1d6f91c31f76f9b6313663` |
| 18 | 0018 | `0018_webhook_only_settlement_evidence.sql` | `f1b906bf12e30c5a4e0c8ecaf5b72b9d1c319d014fda42d303fbcb2f4e896935` |
| 19 | 0019 | `0019_custom_design_requests.sql` | `8ee7fd272953e25aaba888aeff0ac19eb714b8f77c82734ebb47561f7659c94f` |
| 20 | 0020 | `0020_custom_design_admin_review.sql` | `d05c3d7c0921f1c3faecb7fda758afef43dbd69c57c6418ff6f7f4dd6aa1d0f4` |
| 21 | 0021 | `0021_admin_activity_audit.sql` | `a68311d13e6532628ece129c409b9d771c2e617a8a831b0f0f9b5a7244b0fe5e` |
| 22 | 0022 | `0022_custom_design_customer_replies.sql` | `1d8625d50d2ea58f9bb815c5d50a6b179e2123e5282c97dc090d99f4162432c7` |
| 23 | 0023 | `0023_manual_bank_transfer_settlement.sql` | `8d9896000cd14f53f8ef9a74a72e2e9d644e7809ce3096a7486372ca9a1bf75f` |
