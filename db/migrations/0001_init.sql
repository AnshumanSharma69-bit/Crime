CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE cities (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  centroid geography(Point,4326) NOT NULL,
  boundary geography(MultiPolygon,4326)  -- NULL until a verified boundary is imported
);

CREATE TABLE areas (
  id SERIAL PRIMARY KEY,
  city_id INT NOT NULL REFERENCES cities(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('police_station_area','locality','ward')),
  geom geography(MultiPolygon,4326),
  UNIQUE (city_id, kind, name)
);

CREATE TABLE sources (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('official_police','official_dataset','statistical','news')),
  url TEXT NOT NULL,
  city_id INT REFERENCES cities(id),
  categories TEXT[] NOT NULL DEFAULT '{}',
  collection_method TEXT NOT NULL CHECK (collection_method IN ('html_listing','rss','api','file_download','manual_import')),
  terms_url TEXT,
  terms_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('connected','temporarily_unavailable','requires_configuration','manual_import','unsupported')),
  parser_status TEXT NOT NULL DEFAULT 'not_implemented' CHECK (parser_status IN ('not_implemented','implemented_unverified','implemented_verified')),
  robots_checked_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_published_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'  -- non-secret settings only
);

CREATE TABLE source_fetch_runs (
  id BIGSERIAL PRIMARY KEY,
  source_id INT NOT NULL REFERENCES sources(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('success','partial','failed')),
  attempt INT NOT NULL DEFAULT 1,
  items_found INT NOT NULL DEFAULT 0,
  items_new INT NOT NULL DEFAULT 0,
  items_updated INT NOT NULL DEFAULT 0,
  triggered_by TEXT NOT NULL DEFAULT 'schedule',
  error TEXT
);

CREATE TABLE source_documents (
  id BIGSERIAL PRIMARY KEY,
  source_id INT NOT NULL REFERENCES sources(id),
  canonical_url TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  language TEXT,
  body_text TEXT,
  content_hash TEXT,
  published_at TIMESTAMPTZ,       -- when the source says it was published
  first_fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','processed','updated','ignored','error')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, canonical_url)
);

CREATE TABLE incident_categories (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INT NOT NULL
);

CREATE TABLE extraction_candidates (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES source_documents(id),
  kind TEXT NOT NULL CHECK (kind IN ('new_incident','update','opinion','historical','unrelated')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','accepted','rejected','merged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id INT NOT NULL REFERENCES cities(id),
  category_code TEXT NOT NULL REFERENCES incident_categories(code),
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  event_start TIMESTAMPTZ,
  event_end TIMESTAMPTZ,
  area_id INT REFERENCES areas(id),
  location geography(Point,4326),
  location_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (location_precision IN ('street','neighbourhood','police_station_area','city','unknown')),
  location_confidence TEXT NOT NULL DEFAULT 'low' CHECK (location_confidence IN ('low','medium','high')),
  verification_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (verification_status IN
    ('pending_review','reported_by_news','reported_by_official','corroborated','corrected','disputed','archived')),
  verification_note TEXT NOT NULL DEFAULT '',
  publication_status TEXT NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('draft','published','archived','removed')),
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- never invent coordinates; exact victim addresses are not a storable precision
  CHECK (location IS NOT NULL OR location_precision = 'unknown')
);

CREATE TABLE incident_sources (
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  document_id BIGINT NOT NULL REFERENCES source_documents(id),
  role TEXT NOT NULL CHECK (role IN ('primary','corroboration','update','correction')),
  extraction_confidence TEXT CHECK (extraction_confidence IN ('low','medium','high')),
  PRIMARY KEY (incident_id, document_id)
);

CREATE TABLE incident_updates (
  id BIGSERIAL PRIMARY KEY,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ,
  kind TEXT NOT NULL CHECK (kind IN ('development','arrest','charge','court_outcome','correction','note')),
  summary TEXT NOT NULL,
  document_id BIGINT REFERENCES source_documents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','reviewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification_reviews (
  id BIGSERIAL PRIMARY KEY,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES admin_users(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  explanation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES admin_users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX incidents_location_gix ON incidents USING GIST (location);
CREATE INDEX areas_geom_gix ON areas USING GIST (geom);
CREATE INDEX incidents_feed_idx ON incidents (city_id, event_start DESC) WHERE publication_status = 'published';
CREATE INDEX incidents_category_idx ON incidents (category_code);
CREATE INDEX incidents_verification_idx ON incidents (verification_status);
CREATE INDEX incidents_headline_trgm ON incidents USING GIN (headline gin_trgm_ops);
CREATE INDEX source_documents_published_idx ON source_documents (published_at DESC);
CREATE INDEX source_documents_hash_idx ON source_documents (content_hash);
CREATE INDEX fetch_runs_source_idx ON source_fetch_runs (source_id, started_at DESC);
CREATE INDEX audit_entity_idx ON audit_events (entity_type, entity_id);

CREATE TRIGGER incidents_updated BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER source_documents_updated BEFORE UPDATE ON source_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
