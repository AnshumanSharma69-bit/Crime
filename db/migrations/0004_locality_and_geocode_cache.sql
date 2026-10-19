-- Keep the place name a source gave, even when it matches no defined area (it is also what geocoding starts from).
ALTER TABLE incidents ADD COLUMN locality_text TEXT;
CREATE TABLE geocode_cache (
  query_key  TEXT PRIMARY KEY,                      -- provider|normalised query
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('ok','not_found')),
  lat        DOUBLE PRECISION, lng DOUBLE PRECISION, label TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status = 'not_found' OR (lat IS NOT NULL AND lng IS NOT NULL))
);
