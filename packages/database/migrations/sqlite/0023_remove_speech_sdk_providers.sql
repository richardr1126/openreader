-- Speech SDK is no longer a provider type. Forget the default when it named
-- one, so the first remaining enabled provider becomes the default, then
-- remove the providers. Users who chose one pick another provider.
DELETE FROM `admin_settings`
WHERE `key` = 'defaultTtsProvider'
  AND json_extract(`value_json`, '$') IN (SELECT `slug` FROM `admin_providers` WHERE `provider_type` = 'speech-sdk');
--> statement-breakpoint
DELETE FROM `admin_providers` WHERE `provider_type` = 'speech-sdk';
