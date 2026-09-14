// Generated from the local 00001_baseline.sql schema (public).
// Regenerate after migrations with: supabase gen types --local --schema public
// Supabase extension objects belong in the extensions schema.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      cro_analysts: {
        Row: {
          created_at: string
          email: string
          note: string | null
        }
        Insert: {
          created_at?: string
          email: string
          note?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          note?: string | null
        }
        Relationships: []
      }
      cron_runs: {
        Row: {
          cached: number
          duration_ms: number | null
          failed: number
          failures: Json
          generated: number
          id: number
          job: string
          ok: boolean
          ran_at: string
          total: number
        }
        Insert: {
          cached?: number
          duration_ms?: number | null
          failed?: number
          failures?: Json
          generated?: number
          id?: never
          job: string
          ok: boolean
          ran_at?: string
          total?: number
        }
        Update: {
          cached?: number
          duration_ms?: number | null
          failed?: number
          failures?: Json
          generated?: number
          id?: never
          job?: string
          ok?: boolean
          ran_at?: string
          total?: number
        }
        Relationships: []
      }
      deletion_requests: {
        Row: {
          completed_at: string | null
          created_at: string
          email: string
          error_details: string | null
          id: string
          requested_at: string
          status: string
          tables_affected: Json | null
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          email: string
          error_details?: string | null
          id?: string
          requested_at?: string
          status?: string
          tables_affected?: Json | null
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          email?: string
          error_details?: string | null
          id?: string
          requested_at?: string
          status?: string
          tables_affected?: Json | null
          user_id?: string
        }
        Relationships: []
      }
      entitlements: {
        Row: {
          access_level: string
          created_at: string
          expires_at: string | null
          granted_at: string
          id: string
          order_id: string | null
          payment_environment: string
          product_slug: string
          revoked_at: string | null
          solidgate_subscription_id: string | null
          source: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_level?: string
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          id?: string
          order_id?: string | null
          payment_environment?: string
          product_slug: string
          revoked_at?: string | null
          solidgate_subscription_id?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_level?: string
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          id?: string
          order_id?: string | null
          payment_environment?: string
          product_slug?: string
          revoked_at?: string | null
          solidgate_subscription_id?: string | null
          source?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "entitlements_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      funnel_events: {
        Row: {
          created_at: string
          event_id: string
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          session_id: string
          step_number: number | null
        }
        Insert: {
          created_at?: string
          event_id?: string
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          session_id: string
          step_number?: number | null
        }
        Update: {
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          session_id?: string
          step_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "funnel_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      generation_locks: {
        Row: {
          acquired_at: string
          expires_at: string
          scope: string
          scope_key: string
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          scope: string
          scope_key: string
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          scope?: string
          scope_key?: string
        }
        Relationships: []
      }
      meta_capi_event_claims: {
        Row: {
          created_at: string
          environment: string
          event_id: string
          event_name: string
          id: number
          ip_hash: string
          session_id: string | null
        }
        Insert: {
          created_at?: string
          environment: string
          event_id: string
          event_name: string
          id?: number
          ip_hash: string
          session_id?: string | null
        }
        Update: {
          created_at?: string
          environment?: string
          event_id?: string
          event_name?: string
          id?: number
          ip_hash?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meta_capi_event_claims_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          amount_cents: number
          analytics_captured_at: string | null
          claimed_at: string | null
          created_at: string
          currency: string
          id: string
          order_sequence: number
          payment_environment: string
          product_name: string
          product_slug: string | null
          psp: string
          session_id: string | null
          solidgate_card_source_sequence: number
          solidgate_chargeback_amount_cents: number
          solidgate_chargeback_id: string | null
          solidgate_chargeback_status: string | null
          solidgate_checkout_identity_bound_at: string | null
          solidgate_checkout_identity_legacy: boolean
          solidgate_checkout_locale: string | null
          solidgate_customer_email: string | null
          solidgate_order_id: string | null
          solidgate_original_amount_cents: number | null
          solidgate_payment_action: string | null
          solidgate_payment_status: string | null
          solidgate_pre_dispute_status: string | null
          solidgate_product_id: string | null
          solidgate_refunded_amount_cents: number
          solidgate_submission_started_at: string | null
          solidgate_submission_token: string | null
          solidgate_subscription_id: string | null
          solidgate_verify_url: string | null
          status: string
          tracking_metadata: Json
          updated_at: string
          user_id: string | null
        }
        Insert: {
          amount_cents: number
          analytics_captured_at?: string | null
          claimed_at?: string | null
          created_at?: string
          currency?: string
          id?: string
          order_sequence?: number
          payment_environment?: string
          product_name: string
          product_slug?: string | null
          psp?: string
          session_id?: string | null
          solidgate_card_source_sequence?: number
          solidgate_chargeback_amount_cents?: number
          solidgate_chargeback_id?: string | null
          solidgate_chargeback_status?: string | null
          solidgate_checkout_identity_bound_at?: string | null
          solidgate_checkout_identity_legacy?: boolean
          solidgate_checkout_locale?: string | null
          solidgate_customer_email?: string | null
          solidgate_order_id?: string | null
          solidgate_original_amount_cents?: number | null
          solidgate_payment_action?: string | null
          solidgate_payment_status?: string | null
          solidgate_pre_dispute_status?: string | null
          solidgate_product_id?: string | null
          solidgate_refunded_amount_cents?: number
          solidgate_submission_started_at?: string | null
          solidgate_submission_token?: string | null
          solidgate_subscription_id?: string | null
          solidgate_verify_url?: string | null
          status?: string
          tracking_metadata?: Json
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          amount_cents?: number
          analytics_captured_at?: string | null
          claimed_at?: string | null
          created_at?: string
          currency?: string
          id?: string
          order_sequence?: number
          payment_environment?: string
          product_name?: string
          product_slug?: string | null
          psp?: string
          session_id?: string | null
          solidgate_card_source_sequence?: number
          solidgate_chargeback_amount_cents?: number
          solidgate_chargeback_id?: string | null
          solidgate_chargeback_status?: string | null
          solidgate_checkout_identity_bound_at?: string | null
          solidgate_checkout_identity_legacy?: boolean
          solidgate_checkout_locale?: string | null
          solidgate_customer_email?: string | null
          solidgate_order_id?: string | null
          solidgate_original_amount_cents?: number | null
          solidgate_payment_action?: string | null
          solidgate_payment_status?: string | null
          solidgate_pre_dispute_status?: string | null
          solidgate_product_id?: string | null
          solidgate_refunded_amount_cents?: number
          solidgate_submission_started_at?: string | null
          solidgate_submission_token?: string | null
          solidgate_subscription_id?: string | null
          solidgate_verify_url?: string | null
          status?: string
          tracking_metadata?: Json
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      otp_attempts: {
        Row: {
          attempted_at: string
          email: string
          id: string
          ip_address: string | null
          success: boolean
        }
        Insert: {
          attempted_at?: string
          email: string
          id?: string
          ip_address?: string | null
          success?: boolean
        }
        Update: {
          attempted_at?: string
          email?: string
          id?: string
          ip_address?: string | null
          success?: boolean
        }
        Relationships: []
      }
      quiz_definition_step_edges: {
        Row: {
          edge_index: number
          from_step_id: string
          on_value: string | null
          quiz_variant: string
          to_step_id: string
        }
        Insert: {
          edge_index?: number
          from_step_id: string
          on_value?: string | null
          quiz_variant: string
          to_step_id: string
        }
        Update: {
          edge_index?: number
          from_step_id?: string
          on_value?: string | null
          quiz_variant?: string
          to_step_id?: string
        }
        Relationships: []
      }
      quiz_definition_steps: {
        Row: {
          answer_keys: Json
          entry_skippable: boolean
          is_question: boolean
          is_terminal: boolean
          is_unconditional: boolean
          label: string | null
          label_key: string | null
          option_labels: Json
          option_values: Json
          phase_key: string | null
          position: number
          quiz_variant: string
          sort_index: number
          step_id: string
          step_type: string
          store_as: string | null
        }
        Insert: {
          answer_keys?: Json
          entry_skippable?: boolean
          is_question: boolean
          is_terminal?: boolean
          is_unconditional?: boolean
          label?: string | null
          label_key?: string | null
          option_labels?: Json
          option_values?: Json
          phase_key?: string | null
          position: number
          quiz_variant: string
          sort_index: number
          step_id: string
          step_type: string
          store_as?: string | null
        }
        Update: {
          answer_keys?: Json
          entry_skippable?: boolean
          is_question?: boolean
          is_terminal?: boolean
          is_unconditional?: boolean
          label?: string | null
          label_key?: string | null
          option_labels?: Json
          option_values?: Json
          phase_key?: string | null
          position?: number
          quiz_variant?: string
          sort_index?: number
          step_id?: string
          step_type?: string
          store_as?: string | null
        }
        Relationships: []
      }
      quiz_definitions: {
        Row: {
          app_key: string
          config_hash: string
          first_step_id: string
          funnel_key: string
          published_at: string
          quiz_variant: string
          total_steps: number
        }
        Insert: {
          app_key: string
          config_hash: string
          first_step_id: string
          funnel_key: string
          published_at?: string
          quiz_variant: string
          total_steps: number
        }
        Update: {
          app_key?: string
          config_hash?: string
          first_step_id?: string
          funnel_key?: string
          published_at?: string
          quiz_variant?: string
          total_steps?: number
        }
        Relationships: []
      }
      renewal_events: {
        Row: {
          amount_cents: number
          chargeback_amount_cents: number
          chargeback_id: string | null
          chargeback_status: string | null
          created_at: string
          currency: string
          event_created_at: string | null
          gross_amount_cents: number | null
          id: string
          invoice_created_at: string | null
          payment_environment: string
          product_key: string | null
          refunded_amount_cents: number
          solidgate_invoice_id: string | null
          solidgate_order_id: string | null
          solidgate_subscription_id: string | null
          status: string
          subscription_term_number: number | null
        }
        Insert: {
          amount_cents: number
          chargeback_amount_cents?: number
          chargeback_id?: string | null
          chargeback_status?: string | null
          created_at?: string
          currency: string
          event_created_at?: string | null
          gross_amount_cents?: number | null
          id?: string
          invoice_created_at?: string | null
          payment_environment?: string
          product_key?: string | null
          refunded_amount_cents?: number
          solidgate_invoice_id?: string | null
          solidgate_order_id?: string | null
          solidgate_subscription_id?: string | null
          status?: string
          subscription_term_number?: number | null
        }
        Update: {
          amount_cents?: number
          chargeback_amount_cents?: number
          chargeback_id?: string | null
          chargeback_status?: string | null
          created_at?: string
          currency?: string
          event_created_at?: string | null
          gross_amount_cents?: number | null
          id?: string
          invoice_created_at?: string | null
          payment_environment?: string
          product_key?: string | null
          refunded_amount_cents?: number
          solidgate_invoice_id?: string | null
          solidgate_order_id?: string | null
          solidgate_subscription_id?: string | null
          status?: string
          subscription_term_number?: number | null
        }
        Relationships: []
      }
      sessions: {
        Row: {
          attribution: Json
          client_context: Json
          completed_at: string | null
          consent_given_at: string | null
          consent_version: string | null
          created_at: string
          current_step_id: string | null
          email: string | null
          funnel_variant: string
          id: string
          last_oto_step: string | null
          locale: string
          marketing_consent: boolean | null
          quiz_answers: Json
          quiz_result: Json | null
          quiz_variant: string
          result_segment: string | null
          revision: number
          solidgate_oto_environment: string | null
          source: string
          status: string
          step_activity: Json
          updated_at: string
          user_id: string | null
          visitor_id: string | null
          welcome_email_pending: boolean
        }
        Insert: {
          attribution?: Json
          client_context?: Json
          completed_at?: string | null
          consent_given_at?: string | null
          consent_version?: string | null
          created_at?: string
          current_step_id?: string | null
          email?: string | null
          funnel_variant?: string
          id?: string
          last_oto_step?: string | null
          locale: string
          marketing_consent?: boolean | null
          quiz_answers?: Json
          quiz_result?: Json | null
          quiz_variant?: string
          result_segment?: string | null
          revision?: number
          solidgate_oto_environment?: string | null
          source?: string
          status?: string
          step_activity?: Json
          updated_at?: string
          user_id?: string | null
          visitor_id?: string | null
          welcome_email_pending?: boolean
        }
        Update: {
          attribution?: Json
          client_context?: Json
          completed_at?: string | null
          consent_given_at?: string | null
          consent_version?: string | null
          created_at?: string
          current_step_id?: string | null
          email?: string | null
          funnel_variant?: string
          id?: string
          last_oto_step?: string | null
          locale?: string
          marketing_consent?: boolean | null
          quiz_answers?: Json
          quiz_result?: Json | null
          quiz_variant?: string
          result_segment?: string | null
          revision?: number
          solidgate_oto_environment?: string | null
          source?: string
          status?: string
          step_activity?: Json
          updated_at?: string
          user_id?: string | null
          visitor_id?: string | null
          welcome_email_pending?: boolean
        }
        Relationships: []
      }
      solidgate_account_vault: {
        Row: {
          card_brand: string | null
          card_last4: string | null
          card_original_payment_method: string | null
          card_source_created_at: string
          card_source_id: string
          card_source_kind: string
          card_source_sequence: number
          card_token: string | null
          created_at: string
          customer_account_id: string
          payment_environment: string
          session_origin_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          card_brand?: string | null
          card_last4?: string | null
          card_original_payment_method?: string | null
          card_source_created_at?: string
          card_source_id?: string
          card_source_kind?: string
          card_source_sequence?: number
          card_token?: string | null
          created_at?: string
          customer_account_id: string
          payment_environment?: string
          session_origin_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          card_brand?: string | null
          card_last4?: string | null
          card_original_payment_method?: string | null
          card_source_created_at?: string
          card_source_id?: string
          card_source_kind?: string
          card_source_sequence?: number
          card_token?: string | null
          created_at?: string
          customer_account_id?: string
          payment_environment?: string
          session_origin_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "solidgate_account_vault_session_origin_id_fkey"
            columns: ["session_origin_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      solidgate_analytics_outbox: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          distinct_id: string
          environment: string
          event_key: string
          event_name: string
          id: string
          insert_id: string
          last_error: string | null
          next_attempt_at: string
          processing_started_at: string | null
          properties: Json
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          distinct_id: string
          environment?: string
          event_key: string
          event_name: string
          id?: string
          insert_id: string
          last_error?: string | null
          next_attempt_at?: string
          processing_started_at?: string | null
          properties?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          distinct_id?: string
          environment?: string
          event_key?: string
          event_name?: string
          id?: string
          insert_id?: string
          last_error?: string | null
          next_attempt_at?: string
          processing_started_at?: string | null
          properties?: Json
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      solidgate_card_update_attempts: {
        Row: {
          apply_started_at: string | null
          apply_token: string | null
          builder_started_at: string | null
          builder_token: string | null
          checkout_locale: string
          completed_at: string | null
          created_at: string
          customer_email: string
          id: string
          is_current: boolean
          last_provider_status: string | null
          merchant_data: Json | null
          payment_environment: string
          solidgate_order_id: string
          source_sequence: number
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          apply_started_at?: string | null
          apply_token?: string | null
          builder_started_at?: string | null
          builder_token?: string | null
          checkout_locale: string
          completed_at?: string | null
          created_at?: string
          customer_email: string
          id?: string
          is_current?: boolean
          last_provider_status?: string | null
          merchant_data?: Json | null
          payment_environment: string
          solidgate_order_id: string
          source_sequence?: number
          state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          apply_started_at?: string | null
          apply_token?: string | null
          builder_started_at?: string | null
          builder_token?: string | null
          checkout_locale?: string
          completed_at?: string | null
          created_at?: string
          customer_email?: string
          id?: string
          is_current?: boolean
          last_provider_status?: string | null
          merchant_data?: Json | null
          payment_environment?: string
          solidgate_order_id?: string
          source_sequence?: number
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      solidgate_entity_watermarks: {
        Row: {
          entity_id: string
          entity_type: string
          last_event_created_at: string | null
          last_event_id: string | null
          processing_event_created_at: string | null
          processing_event_id: string | null
          processing_started_at: string | null
          updated_at: string
        }
        Insert: {
          entity_id: string
          entity_type: string
          last_event_created_at?: string | null
          last_event_id?: string | null
          processing_event_created_at?: string | null
          processing_event_id?: string | null
          processing_started_at?: string | null
          updated_at?: string
        }
        Update: {
          entity_id?: string
          entity_type?: string
          last_event_created_at?: string | null
          last_event_id?: string | null
          processing_event_created_at?: string | null
          processing_event_id?: string | null
          processing_started_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      solidgate_fulfillment_outbox: {
        Row: {
          attempts: number
          claim_token: string | null
          completed_at: string | null
          created_at: string
          effect_key: string
          effect_type: string
          environment: string
          id: string
          last_error: string | null
          next_attempt_at: string
          payload: Json
          processing_started_at: string | null
          solidgate_order_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claim_token?: string | null
          completed_at?: string | null
          created_at?: string
          effect_key: string
          effect_type: string
          environment: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          payload?: Json
          processing_started_at?: string | null
          solidgate_order_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claim_token?: string | null
          completed_at?: string | null
          created_at?: string
          effect_key?: string
          effect_type?: string
          environment?: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          payload?: Json
          processing_started_at?: string | null
          solidgate_order_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      solidgate_intro_claims: {
        Row: {
          consumed_at: string | null
          created_at: string
          email_hash: string
          lease_expires_at: string
          payment_environment: string
          session_id: string | null
          solidgate_subscription_id: string | null
          state: string
          superseded_subscription_ids: string[]
          tier: string
          updated_at: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          email_hash: string
          lease_expires_at?: string
          payment_environment: string
          session_id?: string | null
          solidgate_subscription_id?: string | null
          state?: string
          superseded_subscription_ids?: string[]
          tier: string
          updated_at?: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          email_hash?: string
          lease_expires_at?: string
          payment_environment?: string
          session_id?: string | null
          solidgate_subscription_id?: string | null
          state?: string
          superseded_subscription_ids?: string[]
          tier?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "solidgate_intro_claims_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      solidgate_invoice_orders: {
        Row: {
          amount_cents: number
          chargeback_amount_cents: number
          chargeback_id: string | null
          chargeback_status: string | null
          created_at: string
          currency: string
          environment: string
          event_created_at: string | null
          operation: string | null
          order_metadata: Json
          product_price_id: string | null
          refunded_amount_cents: number
          solidgate_invoice_id: string
          solidgate_order_id: string
          solidgate_subscription_id: string
          source_created_at: string | null
          source_updated_at: string | null
          status: string
          subscription_term_number: number | null
          updated_at: string
        }
        Insert: {
          amount_cents?: number
          chargeback_amount_cents?: number
          chargeback_id?: string | null
          chargeback_status?: string | null
          created_at?: string
          currency: string
          environment?: string
          event_created_at?: string | null
          operation?: string | null
          order_metadata?: Json
          product_price_id?: string | null
          refunded_amount_cents?: number
          solidgate_invoice_id: string
          solidgate_order_id: string
          solidgate_subscription_id: string
          source_created_at?: string | null
          source_updated_at?: string | null
          status: string
          subscription_term_number?: number | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          chargeback_amount_cents?: number
          chargeback_id?: string | null
          chargeback_status?: string | null
          created_at?: string
          currency?: string
          environment?: string
          event_created_at?: string | null
          operation?: string | null
          order_metadata?: Json
          product_price_id?: string | null
          refunded_amount_cents?: number
          solidgate_invoice_id?: string
          solidgate_order_id?: string
          solidgate_subscription_id?: string
          source_created_at?: string | null
          source_updated_at?: string | null
          status?: string
          subscription_term_number?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      solidgate_main_checkout_states: {
        Row: {
          build_started_at: string
          builder_token: string
          created_at: string
          merchant_data: Json | null
          offer_slug: string
          order_db_id: string
          payment_environment: string
          product_slug: string
          session_id: string
          updated_at: string
        }
        Insert: {
          build_started_at?: string
          builder_token: string
          created_at?: string
          merchant_data?: Json | null
          offer_slug: string
          order_db_id: string
          payment_environment: string
          product_slug: string
          session_id: string
          updated_at?: string
        }
        Update: {
          build_started_at?: string
          builder_token?: string
          created_at?: string
          merchant_data?: Json | null
          offer_slug?: string
          order_db_id?: string
          payment_environment?: string
          product_slug?: string
          session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "solidgate_main_checkout_states_order_db_id_fkey"
            columns: ["order_db_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "solidgate_main_checkout_states_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      solidgate_pwa_purchase_states: {
        Row: {
          claim_kind: string | null
          claim_started_at: string | null
          claim_token: string
          created_at: string
          last_result_kind: string | null
          last_result_net_amount_cents: number | null
          last_result_subscription_id: string | null
          last_result_verify_url: string | null
          merchant_data: Json | null
          offer_slug: string
          order_db_id: string
          payment_environment: string
          product_slug: string
          purchase_mode: string
          updated_at: string
          user_id: string
        }
        Insert: {
          claim_kind?: string | null
          claim_started_at?: string | null
          claim_token: string
          created_at?: string
          last_result_kind?: string | null
          last_result_net_amount_cents?: number | null
          last_result_subscription_id?: string | null
          last_result_verify_url?: string | null
          merchant_data?: Json | null
          offer_slug: string
          order_db_id: string
          payment_environment: string
          product_slug: string
          purchase_mode: string
          updated_at?: string
          user_id: string
        }
        Update: {
          claim_kind?: string | null
          claim_started_at?: string | null
          claim_token?: string
          created_at?: string
          last_result_kind?: string | null
          last_result_net_amount_cents?: number | null
          last_result_subscription_id?: string | null
          last_result_verify_url?: string | null
          merchant_data?: Json | null
          offer_slug?: string
          order_db_id?: string
          payment_environment?: string
          product_slug?: string
          purchase_mode?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "solidgate_pwa_purchase_states_order_db_id_fkey"
            columns: ["order_db_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      solidgate_session_vault: {
        Row: {
          card_brand: string | null
          card_last4: string | null
          card_original_payment_method: string | null
          card_source_created_at: string | null
          card_source_legacy: boolean
          card_source_order_id: string | null
          card_source_sequence: number | null
          card_token: string | null
          created_at: string
          customer_account_id: string
          payment_environment: string
          session_id: string
          updated_at: string
        }
        Insert: {
          card_brand?: string | null
          card_last4?: string | null
          card_original_payment_method?: string | null
          card_source_created_at?: string | null
          card_source_legacy?: boolean
          card_source_order_id?: string | null
          card_source_sequence?: number | null
          card_token?: string | null
          created_at?: string
          customer_account_id: string
          payment_environment?: string
          session_id: string
          updated_at?: string
        }
        Update: {
          card_brand?: string | null
          card_last4?: string | null
          card_original_payment_method?: string | null
          card_source_created_at?: string | null
          card_source_legacy?: boolean
          card_source_order_id?: string | null
          card_source_sequence?: number | null
          card_token?: string | null
          created_at?: string
          customer_account_id?: string
          payment_environment?: string
          session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "solidgate_session_vault_card_source_order_id_fkey"
            columns: ["card_source_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "solidgate_session_vault_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      solidgate_subscription_token_sync_jobs: {
        Row: {
          applied_at: string | null
          attempts: number
          claim_token: string | null
          created_at: string
          desired_source_created_at: string
          desired_source_id: string
          desired_source_kind: string
          desired_source_sequence: number
          last_error: string | null
          next_attempt_at: string
          payment_environment: string
          processing_started_at: string | null
          solidgate_subscription_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          applied_at?: string | null
          attempts?: number
          claim_token?: string | null
          created_at?: string
          desired_source_created_at: string
          desired_source_id: string
          desired_source_kind: string
          desired_source_sequence: number
          last_error?: string | null
          next_attempt_at?: string
          payment_environment: string
          processing_started_at?: string | null
          solidgate_subscription_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          applied_at?: string | null
          attempts?: number
          claim_token?: string | null
          created_at?: string
          desired_source_created_at?: string
          desired_source_id?: string
          desired_source_kind?: string
          desired_source_sequence?: number
          last_error?: string | null
          next_attempt_at?: string
          payment_environment?: string
          processing_started_at?: string | null
          solidgate_subscription_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      solidgate_webhook_events: {
        Row: {
          attempts: number
          claim_generation: number
          claim_token: string | null
          completed_at: string | null
          environment: string
          event_created_at: string | null
          event_id: string
          failed_at: string | null
          last_error: string | null
          payload: Json | null
          processing_started_at: string | null
          received_at: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claim_generation?: number
          claim_token?: string | null
          completed_at?: string | null
          environment?: string
          event_created_at?: string | null
          event_id: string
          failed_at?: string | null
          last_error?: string | null
          payload?: Json | null
          processing_started_at?: string | null
          received_at?: string
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claim_generation?: number
          claim_token?: string | null
          completed_at?: string | null
          environment?: string
          event_created_at?: string | null
          event_id?: string
          failed_at?: string | null
          last_error?: string | null
          payload?: Json | null
          processing_started_at?: string | null
          received_at?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_acquisition_attribution: {
        Row: {
          captured_at: string
          created_at: string
          payment_environment: string
          source_order_id: string | null
          source_session_id: string | null
          updated_at: string
          user_id: string
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
          utm_term: string | null
        }
        Insert: {
          captured_at?: string
          created_at?: string
          payment_environment: string
          source_order_id?: string | null
          source_session_id?: string | null
          updated_at?: string
          user_id: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
        }
        Update: {
          captured_at?: string
          created_at?: string
          payment_environment?: string
          source_order_id?: string | null
          source_session_id?: string | null
          updated_at?: string
          user_id?: string
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          utm_term?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_acquisition_attribution_source_order_id_fkey"
            columns: ["source_order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_acquisition_attribution_source_session_id_fkey"
            columns: ["source_session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_prefs: {
        Row: {
          app_open_count: number
          country: string | null
          last_active_at: string | null
          locale: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_open_count?: number
          country?: string | null
          last_active_at?: string | null
          locale: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_open_count?: number
          country?: string | null
          last_active_at?: string | null
          locale?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      solidgate_intro_claims_needing_refund: {
        Row: {
          consumed_at: string | null
          duplicate_count: number | null
          duplicate_subscription_ids: string[] | null
          email_hash: string | null
          granted_subscription_id: string | null
          payment_environment: string | null
          session_id: string | null
          tier: string | null
          updated_at: string | null
        }
        Insert: {
          consumed_at?: string | null
          duplicate_count?: never
          duplicate_subscription_ids?: string[] | null
          email_hash?: string | null
          granted_subscription_id?: string | null
          payment_environment?: string | null
          session_id?: string | null
          tier?: string | null
          updated_at?: string | null
        }
        Update: {
          consumed_at?: string | null
          duplicate_count?: never
          duplicate_subscription_ids?: string[] | null
          email_hash?: string | null
          granted_subscription_id?: string | null
          payment_environment?: string | null
          session_id?: string | null
          tier?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "solidgate_intro_claims_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      complete_quiz_session: {
        Args: {
          p_event_id: string
          p_expected_revision: number
          p_quiz_result: Json
          p_result_segment: string
          p_session_id: string
        }
        Returns: Json
      }
      create_quiz_session: {
        Args: {
          p_attribution: Json
          p_client_context: Json
          p_email: string | null
          p_event_id: string
          p_funnel_variant: string
          p_locale: string
          p_quiz_variant: string
          p_session_id: string
          p_source: string
          p_visitor_id: string | null
        }
        Returns: Json
      }
      is_cro_analyst: {
        Args: Record<PropertyKey, never>
        Returns: boolean
      }
      link_quiz_session_user: {
        Args: { p_session_id: string; p_user_id: string }
        Returns: Json
      }
      save_quiz_session_progress: {
        Args: {
          p_consent_given_at: string | null
          p_consent_version: string | null
          p_current_step_id: string | null
          p_email: string | null
          p_event_id: string | null
          p_event_metadata: Json
          p_event_step_number: number | null
          p_event_type: string | null
          p_expected_revision: number
          p_locale: string | null
          p_marketing_consent: boolean | null
          p_quiz_answers: Json
          p_session_id: string
          p_step_activity?: Json | null
        }
        Returns: Json
      }
      record_funnel_event: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_metadata: Json
          p_occurred_at: string | null
          p_session_id: string
          p_step_number: number | null
        }
        Returns: string
      }
      publish_quiz_definition: {
        Args: {
          p_app_key: string
          p_config_hash: string
          p_first_step_id: string
          p_funnel_key: string
          p_quiz_variant: string
          p_steps: Json
          p_total_steps: number
        }
        Returns: Json
      }
      cro_answer_distribution: {
        Args: {
          p_from: string
          p_funnel_variant?: string | null
          p_locale?: string | null
          p_min_sessions?: number
          p_quiz_variant: string
          p_source?: string | null
          p_step_id?: string | null
          p_to: string
        }
        Returns: {
          answer_key: string
          answer_label: string
          answer_value: string
          answered_sessions: number
          in_option_set: boolean
          label: string
          sessions: number
          sort_index: number
          step_id: string
          step_position: number
          step_type: string
          value_kind: string
        }[]
      }
      cro_check_otp_rate_limit: {
        Args: {
          p_email: string
        }
        Returns: boolean
      }
      cro_funnel_segments: {
        Args: {
          p_from: string
          p_to: string
        }
        Returns: {
          first_seen: string
          id: string
          kind: string
          last_seen: string
          sessions: number
        }[]
      }
      cro_live_sessions: {
        Args: {
          p_funnel_variant?: string | null
          p_locale?: string | null
          p_quiz_variant?: string | null
          p_source?: string | null
          p_window_minutes?: number
        }
        Returns: {
          active_sessions: number
          funnel_variant: string
          in_catalog: boolean
          is_question: boolean
          label: string
          max_dwell_seconds: number
          p50_dwell_seconds: number
          p90_dwell_seconds: number
          quiz_variant: string
          sort_index: number
          step_basis: string
          step_id: string
          step_position: number
        }[]
      }
      cro_quiz_catalog: {
        Args: {
          p_quiz_variant?: string | null
        }
        Returns: {
          answer_keys: Json
          app_key: string
          config_hash: string
          entry_skippable: boolean
          first_step_id: string
          funnel_key: string
          is_question: boolean
          is_terminal: boolean
          is_unconditional: boolean
          label: string
          option_labels: Json
          option_values: Json
          phase_key: string
          published_at: string
          quiz_variant: string
          sort_index: number
          step_id: string
          step_position: number
          step_type: string
          store_as: string
          total_steps: number
        }[]
      }
      cro_record_otp_attempt: {
        Args: {
          p_email: string
          p_ip?: string | null
          p_success: boolean
        }
        Returns: undefined
      }
      cro_segment_breakdown: {
        Args: {
          p_dimension?: string
          p_from: string
          p_funnel_variant?: string | null
          p_min_sessions?: number
          p_quiz_variant?: string | null
          p_source?: string | null
          p_to: string
        }
        Returns: {
          bucket: string
          completed: number
          completion_pct: number
          dimension: string
          max_position_reached: number
          median_max_position: number
          p90_max_position: number
          sessions: number
          with_activity: number
        }[]
      }
      cro_session_totals: {
        Args: {
          p_from: string
          p_funnel_variant?: string | null
          p_locale?: string | null
          p_quiz_variant?: string | null
          p_settled_after?: unknown
          p_source?: string | null
          p_to: string
        }
        Returns: {
          abandoned_settled: number
          completed: number
          funnel_variant: string
          lead_captured: number
          no_activity: number
          p50_seconds_to_complete: number
          p90_seconds_to_complete: number
          quiz_variant: string
          sessions: number
          unsettled: number
          with_activity: number
        }[]
      }
      cro_step_funnel: {
        Args: {
          p_from: string
          p_funnel_variant?: string | null
          p_locale?: string | null
          p_quiz_variant?: string | null
          p_settled_after?: unknown
          p_source?: string | null
          p_to: string
        }
        Returns: {
          advanced: number
          answered: number
          dropped: number
          entry_skippable: boolean
          funnel_variant: string
          has_traffic: boolean
          in_catalog: boolean
          is_question: boolean
          is_terminal: boolean
          is_unconditional: boolean
          label: string
          p50_seconds_to_answer: number
          p90_seconds_to_answer: number
          phase_key: string
          position_cohort: number
          quiz_variant: string
          revisits: number
          skipped: number
          sort_index: number
          step_id: string
          step_position: number
          step_type: string
          total_views: number
          unsettled: number
          viewed: number
        }[]
      }
      advance_solidgate_oto_progress: {
        Args: {
          p_allow_catch_up?: boolean
          p_current_step: number
          p_payment_environment: string
          p_session_id: string
        }
        Returns: {
          advanced: boolean
          conflict: boolean
          persisted_step: number
        }[]
      }
      apply_solidgate_subscription_entitlement_lifecycle: {
        Args: {
          p_access_level: string
          p_expires_at: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_solidgate_subscription_id: string
          p_source: string
          p_status: string
          p_user_id: string
        }
        Returns: string
      }
      bump_user_app_open: {
        Args: { p_default_locale: string; p_user_id: string }
        Returns: {
          app_open_count: number
          last_active_at: string
        }[]
      }
      claim_meta_capi_event: {
        Args: {
          p_environment: string
          p_event_id: string
          p_event_name: string
          p_ip_hash: string
          p_max_events?: number
          p_session_id: string
          p_window_seconds?: number
        }
        Returns: boolean
      }
      claim_solidgate_analytics_outbox: {
        Args: {
          p_environment: string
          p_lease_seconds?: number
          p_limit?: number
        }
        Returns: {
          attempts: number
          completed_at: string | null
          created_at: string
          distinct_id: string
          environment: string
          event_key: string
          event_name: string
          id: string
          insert_id: string
          last_error: string | null
          next_attempt_at: string
          processing_started_at: string | null
          properties: Json
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "solidgate_analytics_outbox"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_solidgate_card_update_attempt: {
        Args: {
          p_apply_token: string
          p_payment_environment: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: string
      }
      claim_solidgate_entity_event: {
        Args: {
          p_entity_id: string
          p_entity_type: string
          p_event_created_at: string
          p_event_id: string
          p_lease_seconds?: number
        }
        Returns: string
      }
      claim_solidgate_fulfillment_outbox: {
        Args: {
          p_environment: string
          p_lease_seconds?: number
          p_limit?: number
        }
        Returns: {
          attempts: number
          claim_token: string | null
          completed_at: string | null
          created_at: string
          effect_key: string
          effect_type: string
          environment: string
          id: string
          last_error: string | null
          next_attempt_at: string
          payload: Json
          processing_started_at: string | null
          solidgate_order_id: string
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "solidgate_fulfillment_outbox"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_solidgate_intro_offer: {
        Args: {
          p_email_hash: string
          p_payment_environment: string
          p_session_id: string
          p_tier: string
        }
        Returns: string
      }
      claim_solidgate_subscription_token_sync: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_payment_environment: string
          p_user_id?: string
        }
        Returns: {
          applied_at: string | null
          attempts: number
          claim_token: string | null
          created_at: string
          desired_source_created_at: string
          desired_source_id: string
          desired_source_kind: string
          desired_source_sequence: number
          last_error: string | null
          next_attempt_at: string
          payment_environment: string
          processing_started_at: string | null
          solidgate_subscription_id: string
          status: string
          updated_at: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "solidgate_subscription_token_sync_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_solidgate_webhook_event: {
        Args: {
          p_environment: string
          p_event_created_at: string
          p_event_id: string
          p_lease_seconds?: number
          p_payload: Json
          p_type: string
        }
        Returns: boolean
      }
      claim_solidgate_webhook_event_v2: {
        Args: {
          p_environment: string
          p_event_created_at: string
          p_event_id: string
          p_lease_seconds?: number
          p_payload: Json
          p_type: string
        }
        Returns: {
          claim_generation: number
          claim_state: string
          claim_token: string
        }[]
      }
      clear_solidgate_legacy_session_vault: {
        Args: { p_payment_environment: string; p_session_id: string }
        Returns: boolean
      }
      complete_solidgate_card_update_attempt: {
        Args: {
          p_apply_token: string
          p_payment_environment: string
          p_provider_status: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      complete_solidgate_entity_event: {
        Args: {
          p_entity_id: string
          p_entity_type: string
          p_event_created_at: string
          p_event_id: string
        }
        Returns: undefined
      }
      complete_solidgate_subscription_token_sync: {
        Args: {
          p_claim_token: string
          p_desired_source_id: string
          p_desired_source_kind: string
          p_payment_environment: string
          p_require_nonbillable?: boolean
          p_solidgate_subscription_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      complete_solidgate_webhook_event_v2: {
        Args: {
          p_claim_generation: number
          p_claim_token: string
          p_environment: string
          p_event_id: string
        }
        Returns: boolean
      }
      consume_solidgate_intro_offer: {
        Args: {
          p_email_hash: string
          p_payment_environment: string
          p_session_id: string
          p_subscription_id: string
          p_tier: string
        }
        Returns: string
      }
      enqueue_solidgate_subscription_token_sync: {
        Args: { p_payment_environment: string; p_user_id: string }
        Returns: number
      }
      fail_solidgate_subscription_token_sync: {
        Args: {
          p_claim_token: string
          p_desired_source_id: string
          p_desired_source_kind: string
          p_last_error: string
          p_payment_environment: string
          p_solidgate_subscription_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      fail_solidgate_webhook_event_v2: {
        Args: {
          p_claim_generation: number
          p_claim_token: string
          p_environment: string
          p_event_id: string
          p_last_error: string
        }
        Returns: boolean
      }
      fence_solidgate_subscription_token_sync_for_tokenless_source: {
        Args: {
          p_payment_environment: string
          p_source_created_at: string
          p_source_id: string
          p_source_kind: string
          p_source_sequence: number
          p_user_id: string
        }
        Returns: number
      }
      finalize_solidgate_card_update_attempt: {
        Args: {
          p_attempt_id: string
          p_builder_token: string
          p_merchant_data: Json
          p_payment_environment: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      finalize_solidgate_main_checkout: {
        Args: {
          p_amount_cents: number
          p_builder_token: string
          p_currency: string
          p_merchant_data: Json
          p_offer_slug: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_session_id: string
          p_solidgate_order_id: string
        }
        Returns: Json
      }
      finalize_solidgate_main_checkout_v2: {
        Args: {
          p_amount_cents: number
          p_builder_token: string
          p_checkout_locale: string
          p_currency: string
          p_customer_email: string
          p_merchant_data: Json
          p_offer_slug: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_session_id: string
          p_solidgate_order_id: string
        }
        Returns: Json
      }
      finalize_solidgate_pwa_form: {
        Args: {
          p_amount_cents: number
          p_claim_token: string
          p_currency: string
          p_merchant_data: Json
          p_offer_slug: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: Json
      }
      finalize_solidgate_pwa_form_v2: {
        Args: {
          p_amount_cents: number
          p_checkout_locale: string
          p_claim_token: string
          p_currency: string
          p_customer_email: string
          p_merchant_data: Json
          p_offer_slug: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: Json
      }
      find_auth_user_id_by_email: { Args: { p_email: string }; Returns: string }
      get_solidgate_card_update_attempt: {
        Args: {
          p_payment_environment: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: {
          attempt_id: string
          attempt_state: string
          bound_checkout_locale: string
          bound_customer_email: string
          is_current: boolean
          source_created_at: string
        }[]
      }
      get_solidgate_main_checkout_identity: {
        Args: {
          p_payment_environment: string
          p_product_slug: string
          p_session_id: string
        }
        Returns: {
          amount_cents: number
          checkout_locale: string
          currency: string
          customer_email: string
          offer_slug: string
          order_db_id: string
          solidgate_payment_action: string
          solidgate_product_id: string
          tracking_metadata: Json
          user_id: string
        }[]
      }
      get_solidgate_pwa_checkout_identity: {
        Args: {
          p_payment_environment: string
          p_product_slug: string
          p_user_id: string
        }
        Returns: {
          amount_cents: number
          checkout_locale: string
          currency: string
          customer_email: string
          offer_slug: string
          order_db_id: string
          purchase_mode: string
          solidgate_payment_action: string
          solidgate_product_id: string
          tracking_metadata: Json
        }[]
      }
      grant_solidgate_main_entitlement: {
        Args: {
          p_amount_cents: number
          p_fallback_expires_at: string
          p_order_id: string
          p_payment_environment: string
          p_product_slug: string
          p_subscription_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      grant_solidgate_oto_entitlement: {
        Args: {
          p_access_level: string
          p_expires_at: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_solidgate_subscription_id: string
          p_source: string
          p_user_id: string
        }
        Returns: boolean
      }
      grant_solidgate_pwa_entitlement: {
        Args: {
          p_access_level: string
          p_expires_at: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_solidgate_subscription_id: string
          p_source: string
          p_user_id: string
        }
        Returns: boolean
      }
      open_solidgate_card_update_attempt: {
        Args: {
          p_builder_token: string
          p_candidate_order_id: string
          p_checkout_locale: string
          p_customer_email: string
          p_payment_environment: string
          p_user_id: string
        }
        Returns: {
          attempt_id: string
          attempt_state: string
          bound_checkout_locale: string
          bound_customer_email: string
          is_new: boolean
          merchant_data: Json
          should_build: boolean
          solidgate_order_id: string
        }[]
      }
      open_solidgate_main_checkout: {
        Args: {
          p_amount_cents: number
          p_builder_token: string
          p_currency: string
          p_offer_slug: string
          p_payment_environment: string
          p_product_name: string
          p_product_slug: string
          p_session_id: string
          p_tracking_metadata: Json
          p_user_id?: string
        }
        Returns: {
          bound_amount_cents: number
          bound_currency: string
          bound_offer_slug: string
          bound_order_status: string
          bound_payment_environment: string
          bound_payment_status: string
          bound_product_name: string
          bound_product_slug: string
          bound_session_id: string
          bound_tracking_metadata: Json
          is_new: boolean
          merchant_data: Json
          order_db_id: string
          should_build: boolean
          solidgate_order_id: string
        }[]
      }
      open_solidgate_main_checkout_v2: {
        Args: {
          p_amount_cents: number
          p_builder_token: string
          p_checkout_locale: string
          p_currency: string
          p_customer_email: string
          p_offer_slug: string
          p_payment_environment: string
          p_product_name: string
          p_product_slug: string
          p_session_id: string
          p_solidgate_payment_action: string
          p_solidgate_product_id: string
          p_tracking_metadata: Json
          p_user_id?: string
        }
        Returns: {
          bound_amount_cents: number
          bound_checkout_locale: string
          bound_currency: string
          bound_customer_email: string
          bound_offer_slug: string
          bound_order_status: string
          bound_payment_environment: string
          bound_payment_status: string
          bound_product_name: string
          bound_product_slug: string
          bound_session_id: string
          bound_solidgate_payment_action: string
          bound_solidgate_product_id: string
          bound_tracking_metadata: Json
          is_new: boolean
          merchant_data: Json
          order_db_id: string
          should_build: boolean
          solidgate_order_id: string
        }[]
      }
      open_solidgate_oto_order_v2: {
        Args: {
          p_amount_cents: number
          p_builder_token: string
          p_checkout_locale: string
          p_currency: string
          p_customer_email: string
          p_order_prefix: string
          p_payment_environment: string
          p_product_name: string
          p_product_slug: string
          p_session_id: string
          p_solidgate_payment_action?: string
          p_solidgate_product_id?: string
          p_tracking_metadata: Json
          p_user_id?: string
        }
        Returns: {
          bound_checkout_locale: string
          bound_currency: string
          bound_customer_email: string
          bound_original_amount_cents: number
          bound_solidgate_payment_action: string
          bound_solidgate_product_id: string
          bound_tracking_metadata: Json
          claim_token: string
          is_new: boolean
          needs_reconcile: boolean
          order_db_id: string
          order_status: string
          should_submit: boolean
          solidgate_order_id: string
          solidgate_payment_status: string
        }[]
      }
      open_solidgate_pwa_purchase: {
        Args: {
          p_amount_cents: number
          p_claim_token: string
          p_currency: string
          p_offer_slug: string
          p_payment_environment: string
          p_product_slug: string
          p_requested_mode: string
          p_tracking_metadata: Json
          p_user_id: string
        }
        Returns: {
          bound_amount_cents: number
          bound_currency: string
          bound_offer_slug: string
          bound_order_status: string
          bound_payment_environment: string
          bound_payment_status: string
          bound_product_name: string
          bound_product_slug: string
          bound_tracking_metadata: Json
          bound_user_id: string
          claim_token: string
          is_new: boolean
          last_result_kind: string
          last_result_net_amount_cents: number
          merchant_data: Json
          needs_reconcile: boolean
          order_db_id: string
          purchase_mode: string
          should_build: boolean
          should_submit: boolean
          solidgate_order_id: string
          solidgate_subscription_id: string
          verify_url: string
        }[]
      }
      open_solidgate_pwa_purchase_v2: {
        Args: {
          p_amount_cents: number
          p_checkout_locale: string
          p_claim_token: string
          p_currency: string
          p_customer_email: string
          p_offer_slug: string
          p_payment_environment: string
          p_product_slug: string
          p_requested_mode: string
          p_solidgate_payment_action: string
          p_solidgate_product_id: string
          p_tracking_metadata: Json
          p_user_id: string
        }
        Returns: {
          bound_amount_cents: number
          bound_checkout_locale: string
          bound_currency: string
          bound_customer_email: string
          bound_offer_slug: string
          bound_order_status: string
          bound_payment_environment: string
          bound_payment_status: string
          bound_product_name: string
          bound_product_slug: string
          bound_solidgate_payment_action: string
          bound_solidgate_product_id: string
          bound_tracking_metadata: Json
          bound_user_id: string
          claim_token: string
          is_new: boolean
          last_result_kind: string
          last_result_net_amount_cents: number
          merchant_data: Json
          needs_reconcile: boolean
          order_db_id: string
          purchase_mode: string
          should_build: boolean
          should_submit: boolean
          solidgate_order_id: string
          solidgate_subscription_id: string
          verify_url: string
        }[]
      }
      persist_user_acquisition_attribution: {
        Args: {
          p_captured_at: string
          p_payment_environment: string
          p_source_order_id: string
          p_source_session_id: string
          p_user_id: string
          p_utm_campaign?: string
          p_utm_content?: string
          p_utm_medium?: string
          p_utm_source?: string
          p_utm_term?: string
        }
        Returns: boolean
      }
      promote_solidgate_session_vault_monotonic: {
        Args: {
          p_payment_environment: string
          p_session_id: string
          p_user_id: string
        }
        Returns: string
      }
      promote_solidgate_session_vault_with_method: {
        Args: {
          p_payment_environment: string
          p_session_id: string
          p_user_id: string
        }
        Returns: string
      }
      read_claimed_solidgate_subscription_token_sync: {
        Args: {
          p_claim_token: string
          p_payment_environment: string
          p_solidgate_subscription_id: string
          p_user_id: string
        }
        Returns: {
          card_token: string
          desired_source_created_at: string
          desired_source_id: string
          desired_source_kind: string
          desired_source_sequence: number
          subscription_is_billable: boolean
        }[]
      }
      reconcile_solidgate_legacy_order_identity: {
        Args: {
          p_card_brand: string
          p_card_last4: string
          p_card_token: string
          p_currency: string
          p_customer_account_id: string
          p_customer_email: string
          p_order_description: string
          p_order_metadata: Json
          p_original_amount_cents: number
          p_payment_environment: string
          p_solidgate_order_id: string
          p_solidgate_product_id: string
        }
        Returns: boolean
      }
      record_solidgate_card_update_attempt_status: {
        Args: {
          p_payment_environment: string
          p_provider_status: string
          p_solidgate_order_id: string
          p_terminal?: boolean
          p_user_id: string
        }
        Returns: boolean
      }
      record_solidgate_pwa_confirmed_capture: {
        Args: {
          p_amount_cents: number
          p_currency: string
          p_offer_slug: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_provider_status: string
          p_solidgate_order_id: string
          p_subscription_id: string
          p_user_id: string
        }
        Returns: string
      }
      record_solidgate_pwa_submission_result: {
        Args: {
          p_amount_cents: number
          p_claim_token: string
          p_currency: string
          p_net_amount_cents: number
          p_offer_slug: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_provider_status: string
          p_result_kind: string
          p_solidgate_order_id: string
          p_subscription_id: string
          p_user_id: string
          p_verify_url: string
        }
        Returns: boolean
      }
      release_solidgate_card_update_attempt: {
        Args: {
          p_apply_token: string
          p_payment_environment: string
          p_provider_status: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      release_solidgate_entity_event: {
        Args: { p_entity_id: string; p_entity_type: string; p_event_id: string }
        Returns: undefined
      }
      resume_solidgate_oto_order_after_absent_reconcile: {
        Args: {
          p_builder_token: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_session_id: string
          p_solidgate_order_id: string
        }
        Returns: boolean
      }
      resume_solidgate_pwa_submission_after_absent_reconcile: {
        Args: {
          p_amount_cents: number
          p_claim_token: string
          p_currency: string
          p_offer_slug: string
          p_order_db_id: string
          p_payment_environment: string
          p_product_slug: string
          p_solidgate_order_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      revoke_user_auth_sessions: {
        Args: { p_user_id: string }
        Returns: number
      }
      solidgate_checkout_core_is_canonical: {
        Args: { p_order: Database["public"]["Tables"]["orders"]["Row"] }
        Returns: boolean
      }
      solidgate_main_checkout_amount: {
        Args: { p_currency: string; p_offer_slug: string }
        Returns: number
      }
      solidgate_oto_step_from_internal_slug: {
        Args: { p_internal_slug: string }
        Returns: number
      }
      solidgate_oto_step_from_product_slug: {
        Args: { p_product_slug: string }
        Returns: number
      }
      solidgate_persisted_oto_step: {
        Args: { p_last_oto_step: string }
        Returns: number
      }
      solidgate_pwa_product_code: {
        Args: { p_offer_slug: string }
        Returns: string
      }
      solidgate_special_free_card_ready: {
        Args: { p_order_id: string }
        Returns: boolean
      }
      solidgate_subscription_token_sync_is_billable: {
        Args: {
          p_payment_environment: string
          p_solidgate_subscription_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      write_solidgate_account_vault_monotonic: {
        Args: {
          p_card_brand: string
          p_card_last4: string
          p_card_token: string
          p_payment_environment: string
          p_source_claim_token: string
          p_source_id: string
          p_source_kind: string
          p_user_id: string
        }
        Returns: string
      }
      write_solidgate_account_vault_with_method: {
        Args: {
          p_card_brand: string
          p_card_last4: string
          p_card_token: string
          p_original_payment_method: string
          p_payment_environment: string
          p_source_claim_token: string
          p_source_id: string
          p_source_kind: string
          p_user_id: string
        }
        Returns: string
      }
      write_solidgate_session_vault_monotonic: {
        Args: {
          p_card_brand: string
          p_card_last4: string
          p_card_token: string
          p_customer_account_id: string
          p_payment_environment: string
          p_session_id: string
          p_source_order_id: string
        }
        Returns: string
      }
      write_solidgate_session_vault_with_method: {
        Args: {
          p_card_brand: string
          p_card_last4: string
          p_card_token: string
          p_customer_account_id: string
          p_original_payment_method: string
          p_payment_environment: string
          p_session_id: string
          p_source_order_id: string
        }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
