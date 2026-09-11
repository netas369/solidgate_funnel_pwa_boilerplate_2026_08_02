-- Optional reusable advisor/chat module. The owning user lives on the
-- conversation only; messages derive ownership through their parent so the two
-- identities cannot drift.

CREATE TABLE IF NOT EXISTS public.advisor_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  advisor_key TEXT NOT NULL DEFAULT 'default',
  title TEXT,
  preview TEXT,
  last_message_preview TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,

  CONSTRAINT advisor_conversations_advisor_key_check CHECK (
    advisor_key = LOWER(advisor_key)
    AND advisor_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'
  ),
  CONSTRAINT advisor_conversations_title_check CHECK (
    title IS NULL OR CHAR_LENGTH(title) BETWEEN 1 AND 160
  ),
  CONSTRAINT advisor_conversations_preview_check CHECK (
    preview IS NULL OR CHAR_LENGTH(preview) <= 280
  ),
  CONSTRAINT advisor_conversations_last_preview_check CHECK (
    last_message_preview IS NULL
    OR CHAR_LENGTH(last_message_preview) <= 280
  )
);

CREATE INDEX IF NOT EXISTS advisor_conversations_user_activity_idx
  ON public.advisor_conversations (
    user_id,
    last_message_at DESC NULLS LAST,
    created_at DESC
  );

ALTER TABLE public.advisor_conversations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.advisor_conversations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.advisor_conversations
  TO authenticated;
GRANT ALL ON TABLE public.advisor_conversations TO service_role;

CREATE POLICY "Users read own advisor conversations"
  ON public.advisor_conversations FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users create own advisor conversations"
  ON public.advisor_conversations FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users update own advisor conversations"
  ON public.advisor_conversations FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users delete own advisor conversations"
  ON public.advisor_conversations FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE TABLE IF NOT EXISTS public.advisor_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL
    REFERENCES public.advisor_conversations(id) ON DELETE CASCADE,
  client_message_id UUID,
  role TEXT NOT NULL,
  message_content TEXT,
  message_kind TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'complete',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT advisor_messages_role_check CHECK (
    role IN ('user', 'advisor')
  ),
  CONSTRAINT advisor_messages_kind_check CHECK (
    message_kind IN ('text', 'image', 'mixed')
  ),
  CONSTRAINT advisor_messages_status_check CHECK (
    status IN ('pending', 'complete', 'failed')
  ),
  CONSTRAINT advisor_messages_content_check CHECK (
    message_content IS NULL
    OR (
      BTRIM(message_content) <> ''
      AND CHAR_LENGTH(message_content) <= 50000
    )
  ),
  CONSTRAINT advisor_messages_payload_check CHECK (
    message_content IS NOT NULL OR message_kind IN ('image', 'mixed')
  ),
  CONSTRAINT advisor_messages_metadata_object_check CHECK (
    JSONB_TYPEOF(metadata) = 'object'
  ),
  CONSTRAINT advisor_messages_metadata_size_check CHECK (
    OCTET_LENGTH(metadata::TEXT) <= 32768
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS advisor_messages_client_dedupe_key
  ON public.advisor_messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS advisor_messages_conversation_time_idx
  ON public.advisor_messages (conversation_id, created_at, id);

ALTER TABLE public.advisor_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.advisor_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.advisor_messages TO authenticated;
GRANT ALL ON TABLE public.advisor_messages TO service_role;

CREATE POLICY "Users read messages from own advisor conversations"
  ON public.advisor_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.advisor_conversations AS conversation
      WHERE conversation.id = advisor_messages.conversation_id
        AND conversation.user_id = (SELECT auth.uid())
    )
  );
CREATE POLICY "Users create user messages in own advisor conversations"
  ON public.advisor_messages FOR INSERT TO authenticated
  WITH CHECK (
    role = 'user'
    AND EXISTS (
      SELECT 1
      FROM public.advisor_conversations AS conversation
      WHERE conversation.id = advisor_messages.conversation_id
        AND conversation.user_id = (SELECT auth.uid())
    )
  );

CREATE TABLE IF NOT EXISTS public.advisor_message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL
    REFERENCES public.advisor_messages(id) ON DELETE CASCADE,
  bucket_name TEXT NOT NULL DEFAULT 'advisor-attachments',
  object_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT advisor_message_attachments_bucket_check CHECK (
    bucket_name = BTRIM(bucket_name)
    AND CHAR_LENGTH(bucket_name) BETWEEN 1 AND 100
  ),
  CONSTRAINT advisor_message_attachments_path_check CHECK (
    object_path = BTRIM(object_path)
    AND CHAR_LENGTH(object_path) BETWEEN 1 AND 1024
  ),
  CONSTRAINT advisor_message_attachments_size_check CHECK (
    size_bytes IS NULL OR size_bytes BETWEEN 0 AND 52428800
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS advisor_message_attachments_object_key
  ON public.advisor_message_attachments (bucket_name, object_path);
CREATE INDEX IF NOT EXISTS advisor_message_attachments_message_idx
  ON public.advisor_message_attachments (message_id);

ALTER TABLE public.advisor_message_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.advisor_message_attachments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.advisor_message_attachments TO authenticated;
GRANT ALL ON TABLE public.advisor_message_attachments TO service_role;

CREATE POLICY "Users read attachments from own advisor conversations"
  ON public.advisor_message_attachments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.advisor_messages AS message
      JOIN public.advisor_conversations AS conversation
        ON conversation.id = message.conversation_id
      WHERE message.id = advisor_message_attachments.message_id
        AND conversation.user_id = (SELECT auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION public.sync_advisor_conversation_from_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_preview TEXT;
BEGIN
  v_preview := CASE
    WHEN NEW.message_content IS NOT NULL
      THEN LEFT(REGEXP_REPLACE(BTRIM(NEW.message_content), '\s+', ' ', 'g'), 280)
    WHEN NEW.message_kind = 'image' THEN '[Image]'
    ELSE '[Attachment]'
  END;

  UPDATE public.advisor_conversations AS conversation
  SET title = CASE
        WHEN conversation.title IS NULL AND NEW.role = 'user'
          THEN LEFT(v_preview, 160)
        ELSE conversation.title
      END,
      preview = CASE
        WHEN conversation.preview IS NULL AND NEW.role = 'advisor'
          THEN v_preview
        ELSE conversation.preview
      END,
      last_message_preview = CASE
        WHEN conversation.last_message_at IS NULL
          OR NEW.created_at >= conversation.last_message_at
          THEN v_preview
        ELSE conversation.last_message_preview
      END,
      last_message_at = GREATEST(
        COALESCE(conversation.last_message_at, NEW.created_at),
        NEW.created_at
      ),
      updated_at = now()
  WHERE conversation.id = NEW.conversation_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_advisor_conversation_message
  ON public.advisor_messages;
CREATE TRIGGER sync_advisor_conversation_message
  AFTER INSERT ON public.advisor_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_advisor_conversation_from_message();

REVOKE ALL ON FUNCTION public.sync_advisor_conversation_from_message()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.advisor_conversations IS
  'User-owned advisor conversation headers; title, first-advisor preview, and latest preview are denormalized from messages.';
COMMENT ON TABLE public.advisor_messages IS
  'Immutable advisor transcript. User ownership is inherited from advisor_conversations.';
COMMENT ON TABLE public.advisor_message_attachments IS
  'Private Storage object references. Object deletion must be handled separately from row deletion.';
