-- Vector store for RAG. pgvector lives inside Postgres, so there is no second
-- database to run, back up or keep in sync.
--
-- ${EMBEDDING_DIM} is substituted by the migration runner from the environment.
-- Changing the embedding model means changing the dimension, which means a new
-- migration plus a re-embed of every row — pick the model before you fill this.

CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS memories (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind        text        NOT NULL
        CHECK (kind IN ('note', 'call_transcript', 'email_summary', 'conversation', 'document')),
    content     text        NOT NULL,
    embedding   vector(${EMBEDDING_DIM}) NOT NULL,
    -- Where this came from: { conversationId, callLogId, emailEventId, ... }
    source_ref  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_user_kind_idx ON memories (user_id, kind);

-- Cosine distance matches how the embedding models are trained. `lists` should
-- grow with the table (rule of thumb: rows/1000); 100 is fine to start, and the
-- index must be rebuilt after a large bulk import to be effective.
CREATE INDEX IF NOT EXISTS memories_embedding_idx
    ON memories USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
