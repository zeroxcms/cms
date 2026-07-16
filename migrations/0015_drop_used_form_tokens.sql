-- Single-use admin form tokens now live in sharded Durable Object key/value
-- storage, so their short-lived coordination writes do not contend with CMS D1.
DROP TABLE IF EXISTS used_form_tokens;
