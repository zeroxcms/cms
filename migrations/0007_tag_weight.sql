ALTER TABLE tags ADD COLUMN weight INTEGER DEFAULT 5;

CREATE INDEX IF NOT EXISTS idx_tags_taxonomy_weight_name ON tags(taxonomy_id, weight, name);
