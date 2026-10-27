-- Match the Speech SDK removal: forget a default pointing at a removed setup,
-- then remove its encrypted credential. Existing document audio is untouched.
DELETE FROM `admin_settings`
WHERE `key` = 'defaultTtsProvider'
  AND json_extract(`value_json`, '$') IN (SELECT `slug` FROM `admin_providers` WHERE `provider_type` = 'deepinfra');
--> statement-breakpoint
DELETE FROM `admin_providers` WHERE `provider_type` = 'deepinfra';
