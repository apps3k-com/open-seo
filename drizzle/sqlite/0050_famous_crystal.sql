-- Preserve existing OAuth grants. Duplicate grants cause the unique index
-- below to fail for separate, data-preserving reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS `account_google_grant_owner_idx` ON `account` (`user_id`,`provider_id`,`account_id`) WHERE "account"."provider_id" in ('google-search-console', 'google-analytics');
