CREATE TABLE documents (
    id UUID PRIMARY KEY,
    title VARCHAR(120) NOT NULL CHECK (length(trim(title)) > 0),
    access_token_hash BYTEA NOT NULL CHECK (octet_length(access_token_hash) = 32),
    state BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
