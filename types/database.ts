export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      batches: {
        Row: {
          created_at: string | null
          id: string
          is_active: boolean
          name: string
          strain_id: string | null
          terpenes_percentage: number | null
          thc_percentage: number | null
          total_cannabinoids_percentage: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_active?: boolean
          name: string
          strain_id?: string | null
          terpenes_percentage?: number | null
          thc_percentage?: number | null
          total_cannabinoids_percentage?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          is_active?: boolean
          name?: string
          strain_id?: string | null
          terpenes_percentage?: number | null
          thc_percentage?: number | null
          total_cannabinoids_percentage?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "batches_strain_id_fkey"
            columns: ["strain_id"]
            isOneToOne: false
            referencedRelation: "strains"
            referencedColumns: ["id"]
          },
        ]
      }
      commission_rates: {
        Row: {
          created_at: string | null
          effective_from: string
          effective_to: string | null
          id: string
          min_unit_price: number | null
          product_type_id: string | null
          rate_percent: number
          salesperson_id: string | null
          sku_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          min_unit_price?: number | null
          product_type_id?: string | null
          rate_percent: number
          salesperson_id?: string | null
          sku_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          min_unit_price?: number | null
          product_type_id?: string | null
          rate_percent?: number
          salesperson_id?: string | null
          sku_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commission_rates_product_type_id_fkey"
            columns: ["product_type_id"]
            isOneToOne: false
            referencedRelation: "product_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_rates_salesperson_id_fkey"
            columns: ["salesperson_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_rates_salesperson_id_fkey"
            columns: ["salesperson_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_rates_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commission_rates_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      commissions: {
        Row: {
          commission_amount: number
          created_at: string | null
          id: string
          notes: string | null
          order_date: string
          order_id: string
          order_total: number
          paid_at: string | null
          paid_by: string | null
          rate_applied: number
          salesperson_id: string
          status: string
          updated_at: string | null
        }
        Insert: {
          commission_amount: number
          created_at?: string | null
          id?: string
          notes?: string | null
          order_date: string
          order_id: string
          order_total: number
          paid_at?: string | null
          paid_by?: string | null
          rate_applied: number
          salesperson_id: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          commission_amount?: number
          created_at?: string | null
          id?: string
          notes?: string | null
          order_date?: string
          order_id?: string
          order_total?: number
          paid_at?: string | null
          paid_by?: string | null
          rate_applied?: number
          salesperson_id?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commissions_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_salesperson_id_fkey"
            columns: ["salesperson_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commissions_salesperson_id_fkey"
            columns: ["salesperson_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      communications: {
        Row: {
          agent_id: string | null
          client_name: string | null
          contact_method: string | null
          created_at: string | null
          customer_id: string
          follow_up_required: boolean | null
          id: string
          interaction_date: string | null
          is_edited: boolean | null
          last_edited_at: string | null
          last_edited_by: string | null
          notes: string
          updated_at: string | null
        }
        Insert: {
          agent_id?: string | null
          client_name?: string | null
          contact_method?: string | null
          created_at?: string | null
          customer_id: string
          follow_up_required?: boolean | null
          id?: string
          interaction_date?: string | null
          is_edited?: boolean | null
          last_edited_at?: string | null
          last_edited_by?: string | null
          notes: string
          updated_at?: string | null
        }
        Update: {
          agent_id?: string | null
          client_name?: string | null
          contact_method?: string | null
          created_at?: string | null
          customer_id?: string
          follow_up_required?: boolean | null
          id?: string
          interaction_date?: string | null
          is_edited?: boolean | null
          last_edited_at?: string | null
          last_edited_by?: string | null
          notes?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "communications_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_log: {
        Row: {
          created_at: string
          custom_report_type: string | null
          event_date: string
          id: string
          is_edited: boolean | null
          last_edited_at: string | null
          last_edited_by: string | null
          location: string | null
          logged_by: string
          metadata: Json | null
          metrc_ids: string[] | null
          report_type: string
          search_vector: unknown
          summary: string
          updated_at: string
          witness: string | null
        }
        Insert: {
          created_at?: string
          custom_report_type?: string | null
          event_date: string
          id?: string
          is_edited?: boolean | null
          last_edited_at?: string | null
          last_edited_by?: string | null
          location?: string | null
          logged_by: string
          metadata?: Json | null
          metrc_ids?: string[] | null
          report_type: string
          search_vector?: unknown
          summary: string
          updated_at?: string
          witness?: string | null
        }
        Update: {
          created_at?: string
          custom_report_type?: string | null
          event_date?: string
          id?: string
          is_edited?: boolean | null
          last_edited_at?: string | null
          last_edited_by?: string | null
          location?: string | null
          logged_by?: string
          metadata?: Json | null
          metrc_ids?: string[] | null
          report_type?: string
          search_vector?: unknown
          summary?: string
          updated_at?: string
          witness?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "compliance_log_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_log_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_log_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_log_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          comm_email: boolean | null
          comm_sms: boolean | null
          created_at: string
          dispensary_id: string
          email: string | null
          id: string
          is_primary: boolean | null
          name: string
          notes: string | null
          phone: string | null
          role: string | null
          updated_at: string
        }
        Insert: {
          comm_email?: boolean | null
          comm_sms?: boolean | null
          created_at?: string
          dispensary_id: string
          email?: string | null
          id?: string
          is_primary?: boolean | null
          name: string
          notes?: string | null
          phone?: string | null
          role?: string | null
          updated_at?: string
        }
        Update: {
          comm_email?: boolean | null
          comm_sms?: boolean | null
          created_at?: string
          dispensary_id?: string
          email?: string | null
          id?: string
          is_primary?: boolean | null
          name?: string
          notes?: string | null
          phone?: string | null
          role?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_dispensary_id_fkey"
            columns: ["dispensary_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      containers: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          size: number
          sku_id: string
          source_tag_id: string | null
          status: string
          used_at: string | null
          weight_used: number | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          size: number
          sku_id: string
          source_tag_id?: string | null
          status?: string
          used_at?: string | null
          weight_used?: number | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          size?: number
          sku_id?: string
          source_tag_id?: string | null
          status?: string
          used_at?: string | null
          weight_used?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "containers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "containers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "containers_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "containers_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "containers_source_tag_id_fkey"
            columns: ["source_tag_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["tag_id"]
          },
        ]
      }
      cultivation_task_assignees: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          task_id: string
          user_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          task_id: string
          user_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cultivation_task_assignees_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_task_assignees_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_task_assignees_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "cultivation_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_task_assignees_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_task_assignees_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cultivation_tasks: {
        Row: {
          assigned_group: string | null
          assigned_to: string | null
          attachments: Json | null
          completed_at: string | null
          completed_by: string | null
          completion_notes: string | null
          created_at: string | null
          created_by: string | null
          day_number: number | null
          day_of_week: number | null
          description: string | null
          due_date: string
          estimated_minutes: number | null
          frequency: string | null
          id: string
          last_generated_date: string | null
          phase: string | null
          priority: string
          recurring_parent_id: string | null
          room_cycle_id: string | null
          room_id: string | null
          status: string
          task_type: string
          template_task_id: string | null
          title: string
          updated_at: string | null
        }
        Insert: {
          assigned_group?: string | null
          assigned_to?: string | null
          attachments?: Json | null
          completed_at?: string | null
          completed_by?: string | null
          completion_notes?: string | null
          created_at?: string | null
          created_by?: string | null
          day_number?: number | null
          day_of_week?: number | null
          description?: string | null
          due_date: string
          estimated_minutes?: number | null
          frequency?: string | null
          id?: string
          last_generated_date?: string | null
          phase?: string | null
          priority?: string
          recurring_parent_id?: string | null
          room_cycle_id?: string | null
          room_id?: string | null
          status?: string
          task_type?: string
          template_task_id?: string | null
          title: string
          updated_at?: string | null
        }
        Update: {
          assigned_group?: string | null
          assigned_to?: string | null
          attachments?: Json | null
          completed_at?: string | null
          completed_by?: string | null
          completion_notes?: string | null
          created_at?: string | null
          created_by?: string | null
          day_number?: number | null
          day_of_week?: number | null
          description?: string | null
          due_date?: string
          estimated_minutes?: number | null
          frequency?: string | null
          id?: string
          last_generated_date?: string | null
          phase?: string | null
          priority?: string
          recurring_parent_id?: string | null
          room_cycle_id?: string | null
          room_id?: string | null
          status?: string
          task_type?: string
          template_task_id?: string | null
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cultivation_tasks_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_recurring_parent_id_fkey"
            columns: ["recurring_parent_id"]
            isOneToOne: false
            referencedRelation: "cultivation_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_room_cycle_id_fkey"
            columns: ["room_cycle_id"]
            isOneToOne: false
            referencedRelation: "room_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "grow_rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cultivation_tasks_template_task_id_fkey"
            columns: ["template_task_id"]
            isOneToOne: false
            referencedRelation: "template_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_pricing: {
        Row: {
          created_at: string | null
          customer_id: string
          id: string
          price_per_unit: number
          product_type_id: string | null
          sku_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          customer_id: string
          id?: string
          price_per_unit: number
          product_type_id?: string | null
          sku_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          customer_id?: string
          id?: string
          price_per_unit?: number
          product_type_id?: string | null
          sku_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_pricing_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_pricing_product_type_id_fkey"
            columns: ["product_type_id"]
            isOneToOne: false
            referencedRelation: "product_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_pricing_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_pricing_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          assigned_sales_id: string | null
          business_name: string
          city: string | null
          commission_exempt: boolean | null
          created_at: string | null
          email: string | null
          first_order_date: string | null
          has_orders: boolean | null
          id: string
          is_active: boolean
          last_order_date: string | null
          license_name: string | null
          ob_license: string | null
          omma_license: string | null
          order_count: number | null
          phone_number: string | null
          show_on_map: boolean | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          assigned_sales_id?: string | null
          business_name: string
          city?: string | null
          commission_exempt?: boolean | null
          created_at?: string | null
          email?: string | null
          first_order_date?: string | null
          has_orders?: boolean | null
          id?: string
          is_active?: boolean
          last_order_date?: string | null
          license_name?: string | null
          ob_license?: string | null
          omma_license?: string | null
          order_count?: number | null
          phone_number?: string | null
          show_on_map?: boolean | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          assigned_sales_id?: string | null
          business_name?: string
          city?: string | null
          commission_exempt?: boolean | null
          created_at?: string | null
          email?: string | null
          first_order_date?: string | null
          has_orders?: boolean | null
          id?: string
          is_active?: boolean
          last_order_date?: string | null
          license_name?: string | null
          ob_license?: string | null
          omma_license?: string | null
          order_count?: number | null
          phone_number?: string | null
          show_on_map?: boolean | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_assigned_sales_id_fkey"
            columns: ["assigned_sales_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_assigned_sales_id_fkey"
            columns: ["assigned_sales_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cycle_templates: {
        Row: {
          created_at: string | null
          created_by: string | null
          description: string | null
          duration_days: number | null
          id: string
          is_active: boolean
          name: string
          phase: string | null
          template_type: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          duration_days?: number | null
          id?: string
          is_active?: boolean
          name: string
          phase?: string | null
          template_type?: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          duration_days?: number | null
          id?: string
          is_active?: boolean
          name?: string
          phase?: string | null
          template_type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cycle_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cycle_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_agent_write_log: {
        Row: {
          action: string
          agent: string
          created_at: string
          id: string
          payload: Json | null
          platform: string | null
          record_id: string | null
          requester: string | null
          summary: string
          table_name: string
        }
        Insert: {
          action: string
          agent?: string
          created_at?: string
          id?: string
          payload?: Json | null
          platform?: string | null
          record_id?: string | null
          requester?: string | null
          summary: string
          table_name: string
        }
        Update: {
          action?: string
          agent?: string
          created_at?: string
          id?: string
          payload?: Json | null
          platform?: string | null
          record_id?: string | null
          requester?: string | null
          summary?: string
          table_name?: string
        }
        Relationships: []
      }
      finance_bill_templates: {
        Row: {
          amount: number | null
          category: string | null
          created_at: string
          due_day_of_month: number | null
          id: string
          is_active: boolean
          is_amount_fixed: boolean
          name: string
          notes: string | null
          recurrence: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          amount?: number | null
          category?: string | null
          created_at?: string
          due_day_of_month?: number | null
          id?: string
          is_active?: boolean
          is_amount_fixed?: boolean
          name: string
          notes?: string | null
          recurrence?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          amount?: number | null
          category?: string | null
          created_at?: string
          due_day_of_month?: number | null
          id?: string
          is_active?: boolean
          is_amount_fixed?: boolean
          name?: string
          notes?: string | null
          recurrence?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_bill_templates_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "finance_vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_bills: {
        Row: {
          amount: number
          amount_paid: number
          created_at: string
          created_by: string | null
          due_date: string
          id: string
          name: string
          notes: string | null
          paid_date: string | null
          payment_method: string | null
          payment_ref: string | null
          period_month: string
          planned_pay_date: string | null
          status: string
          template_id: string | null
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          amount: number
          amount_paid?: number
          created_at?: string
          created_by?: string | null
          due_date: string
          id?: string
          name: string
          notes?: string | null
          paid_date?: string | null
          payment_method?: string | null
          payment_ref?: string | null
          period_month: string
          planned_pay_date?: string | null
          status?: string
          template_id?: string | null
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          amount?: number
          amount_paid?: number
          created_at?: string
          created_by?: string | null
          due_date?: string
          id?: string
          name?: string
          notes?: string | null
          paid_date?: string | null
          payment_method?: string | null
          payment_ref?: string | null
          period_month?: string
          planned_pay_date?: string | null
          status?: string
          template_id?: string | null
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_bills_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_bills_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_bills_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "finance_bill_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_bills_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "finance_vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_cash_snapshots: {
        Row: {
          cash_on_hand: number
          created_at: string
          id: string
          notes: string | null
          recorded_by: string | null
          snapshot_date: string
          source: string
        }
        Insert: {
          cash_on_hand: number
          created_at?: string
          id?: string
          notes?: string | null
          recorded_by?: string | null
          snapshot_date: string
          source?: string
        }
        Update: {
          cash_on_hand?: number
          created_at?: string
          id?: string
          notes?: string | null
          recorded_by?: string | null
          snapshot_date?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_cash_snapshots_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_cash_snapshots_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_reconciliation_log: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          bank_amount: number | null
          bank_bs_id: number
          bank_date: string | null
          bank_description: string | null
          bill_amount: number | null
          bill_id: string | null
          created_at: string
          id: string
          match_type: string
          status: string
          suggested_payment_method: string | null
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          bank_amount?: number | null
          bank_bs_id: number
          bank_date?: string | null
          bank_description?: string | null
          bill_amount?: number | null
          bill_id?: string | null
          created_at?: string
          id?: string
          match_type: string
          status: string
          suggested_payment_method?: string | null
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          bank_amount?: number | null
          bank_bs_id?: number
          bank_date?: string | null
          bank_description?: string | null
          bill_amount?: number | null
          bill_id?: string | null
          created_at?: string
          id?: string
          match_type?: string
          status?: string
          suggested_payment_method?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finance_reconciliation_log_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_reconciliation_log_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_reconciliation_log_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "finance_bills"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_vendors: {
        Row: {
          bank_keywords: string | null
          category: string | null
          contact_info: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          bank_keywords?: string | null
          category?: string | null
          contact_info?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          bank_keywords?: string | null
          category?: string | null
          contact_info?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      grow_rooms: {
        Row: {
          created_at: string | null
          current_phase: string
          id: string
          notes: string | null
          pairing_group: string | null
          phase_start_date: string | null
          room_name: string
          room_number: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          current_phase?: string
          id?: string
          notes?: string | null
          pairing_group?: string | null
          phase_start_date?: string | null
          room_name: string
          room_number: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          current_phase?: string
          id?: string
          notes?: string | null
          pairing_group?: string | null
          phase_start_date?: string | null
          room_name?: string
          room_number?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      inventory: {
        Row: {
          cased: number
          filled: number
          sku_id: string
          staged: number
          updated_at: string | null
        }
        Insert: {
          cased?: number
          filled?: number
          sku_id: string
          staged?: number
          updated_at?: string | null
        }
        Update: {
          cased?: number
          filled?: number
          sku_id?: string
          staged?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: true
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_log: {
        Row: {
          container_id: string | null
          created_at: string | null
          field: string
          id: string
          new_value: number
          old_value: number
          order_id: string | null
          reason: string | null
          sku_id: string
          task_id: string | null
          user_id: string | null
        }
        Insert: {
          container_id?: string | null
          created_at?: string | null
          field: string
          id?: string
          new_value: number
          old_value: number
          order_id?: string | null
          reason?: string | null
          sku_id: string
          task_id?: string | null
          user_id?: string | null
        }
        Update: {
          container_id?: string | null
          created_at?: string | null
          field?: string
          id?: string
          new_value?: number
          old_value?: number
          order_id?: string | null
          reason?: string | null
          sku_id?: string
          task_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_log_container_id_fkey"
            columns: ["container_id"]
            isOneToOne: false
            referencedRelation: "containers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_log_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_log_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_log_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_log_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "packaging_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      material_transactions: {
        Row: {
          created_at: string
          id: string
          material_id: string
          notes: string | null
          quantity: number
          sku_id: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          material_id: string
          notes?: string | null
          quantity: number
          sku_id?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          material_id?: string
          notes?: string | null
          quantity?: number
          sku_id?: string | null
          transaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_transactions_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_transactions_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_transactions_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "material_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      materials: {
        Row: {
          created_at: string
          current_stock: number | null
          id: string
          low_stock_threshold: number | null
          material_type: string | null
          name: string
          sku_code: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_stock?: number | null
          id?: string
          low_stock_threshold?: number | null
          material_type?: string | null
          name: string
          sku_code?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_stock?: number | null
          id?: string
          low_stock_threshold?: number | null
          material_type?: string | null
          name?: string
          sku_code?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      order_items: {
        Row: {
          created_at: string | null
          id: string
          line_total: number | null
          order_id: string
          quantity: number
          sku_id: string
          unit_price: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          line_total?: number | null
          order_id: string
          quantity: number
          sku_id: string
          unit_price?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          line_total?: number | null
          order_id?: string
          quantity?: number
          sku_id?: string
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          actual_delivery_date: string | null
          agent_id: string | null
          approved_at: string | null
          approved_by: string | null
          confirmed_delivery_date: string | null
          created_at: string | null
          customer_id: string
          delivered_at: string | null
          id: string
          last_edited_at: string | null
          last_edited_by: string | null
          legacy_row_number: number | null
          order_date: string | null
          order_notes: string | null
          order_number: string | null
          packed_at: string | null
          payment_terms: boolean
          requested_delivery_date: string | null
          status: string
          terms_paid_at: string | null
          terms_payment_date: string | null
          total_price: number | null
          updated_at: string | null
        }
        Insert: {
          actual_delivery_date?: string | null
          agent_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          confirmed_delivery_date?: string | null
          created_at?: string | null
          customer_id: string
          delivered_at?: string | null
          id?: string
          last_edited_at?: string | null
          last_edited_by?: string | null
          legacy_row_number?: number | null
          order_date?: string | null
          order_notes?: string | null
          order_number?: string | null
          packed_at?: string | null
          payment_terms?: boolean
          requested_delivery_date?: string | null
          status?: string
          terms_paid_at?: string | null
          terms_payment_date?: string | null
          total_price?: number | null
          updated_at?: string | null
        }
        Update: {
          actual_delivery_date?: string | null
          agent_id?: string | null
          approved_at?: string | null
          approved_by?: string | null
          confirmed_delivery_date?: string | null
          created_at?: string | null
          customer_id?: string
          delivered_at?: string | null
          id?: string
          last_edited_at?: string | null
          last_edited_by?: string | null
          legacy_row_number?: number | null
          order_date?: string | null
          order_notes?: string | null
          order_number?: string | null
          packed_at?: string | null
          payment_terms?: boolean
          requested_delivery_date?: string | null
          status?: string
          terms_paid_at?: string | null
          terms_payment_date?: string | null
          total_price?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_last_edited_by_fkey"
            columns: ["last_edited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      packages: {
        Row: {
          batch: string
          created_at: string | null
          created_by: string
          current_weight: number
          is_active: boolean | null
          strain: string
          strain_id: string | null
          tag_id: string
          type_id: string
          updated_at: string | null
        }
        Insert: {
          batch: string
          created_at?: string | null
          created_by: string
          current_weight?: number
          is_active?: boolean | null
          strain: string
          strain_id?: string | null
          tag_id: string
          type_id: string
          updated_at?: string | null
        }
        Update: {
          batch?: string
          created_at?: string | null
          created_by?: string
          current_weight?: number
          is_active?: boolean | null
          strain?: string
          strain_id?: string | null
          tag_id?: string
          type_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "packages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packages_strain_id_fkey"
            columns: ["strain_id"]
            isOneToOne: false
            referencedRelation: "strains"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packages_type_id_fkey"
            columns: ["type_id"]
            isOneToOne: false
            referencedRelation: "product_types"
            referencedColumns: ["id"]
          },
        ]
      }
      packaging_claims: {
        Row: {
          claimed_at: string
          claimed_by_name: string
          claimed_by_user_id: string
          claimed_quantity: number
          completed_at: string | null
          expires_at: string
          id: string
          priority: string
          release_reason: string | null
          released_at: string | null
          session_user_id: string | null
          session_user_name: string | null
          sku: string
          status: string
          task_key: string
          task_type: string
        }
        Insert: {
          claimed_at?: string
          claimed_by_name: string
          claimed_by_user_id: string
          claimed_quantity: number
          completed_at?: string | null
          expires_at?: string
          id?: string
          priority: string
          release_reason?: string | null
          released_at?: string | null
          session_user_id?: string | null
          session_user_name?: string | null
          sku: string
          status?: string
          task_key: string
          task_type: string
        }
        Update: {
          claimed_at?: string
          claimed_by_name?: string
          claimed_by_user_id?: string
          claimed_quantity?: number
          completed_at?: string | null
          expires_at?: string
          id?: string
          priority?: string
          release_reason?: string | null
          released_at?: string | null
          session_user_id?: string | null
          session_user_name?: string | null
          sku?: string
          status?: string
          task_key?: string
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "packaging_claims_claimed_by_user_id_fkey"
            columns: ["claimed_by_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_claims_claimed_by_user_id_fkey"
            columns: ["claimed_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_claims_session_user_id_fkey"
            columns: ["session_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_claims_session_user_id_fkey"
            columns: ["session_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      packaging_task_sources: {
        Row: {
          created_at: string | null
          id: string
          is_backfill: boolean | null
          order_id: string | null
          quantity: number
          task_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          is_backfill?: boolean | null
          order_id?: string | null
          quantity: number
          task_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          is_backfill?: boolean | null
          order_id?: string | null
          quantity?: number
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "packaging_task_sources_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_task_sources_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "packaging_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      packaging_task_state: {
        Row: {
          completed_at: string | null
          created_at: string | null
          current_column: string
          id: string
          quantity: number
          sku: string
          task_key: string
          task_type: string
          updated_at: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          current_column: string
          id?: string
          quantity: number
          sku: string
          task_key: string
          task_type: string
          updated_at?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          current_column?: string
          id?: string
          quantity?: number
          sku?: string
          task_key?: string
          task_type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      packaging_tasks: {
        Row: {
          blocked_reason: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string | null
          id: string
          notes: string | null
          priority: string
          quantity: number
          sku_id: string
          status: string
          task_type: string
        }
        Insert: {
          blocked_reason?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          priority: string
          quantity: number
          sku_id: string
          status?: string
          task_type: string
        }
        Update: {
          blocked_reason?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string | null
          id?: string
          notes?: string | null
          priority?: string
          quantity?: number
          sku_id?: string
          status?: string
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "packaging_tasks_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_tasks_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_tasks_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packaging_tasks_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      product_types: {
        Row: {
          created_at: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      room_cycles: {
        Row: {
          actual_end_date: string | null
          created_at: string | null
          created_by: string | null
          current_stage: string
          cycle_number: number | null
          dome_start: string | null
          dry_start: string | null
          expected_end_date: string | null
          flower_start: string | null
          harvest_date: string | null
          id: string
          notes: string | null
          room_id: string
          start_date: string
          status: string
          template_id: string | null
          trim_start: string | null
          updated_at: string | null
          veg_start: string | null
        }
        Insert: {
          actual_end_date?: string | null
          created_at?: string | null
          created_by?: string | null
          current_stage: string
          cycle_number?: number | null
          dome_start?: string | null
          dry_start?: string | null
          expected_end_date?: string | null
          flower_start?: string | null
          harvest_date?: string | null
          id?: string
          notes?: string | null
          room_id: string
          start_date: string
          status?: string
          template_id?: string | null
          trim_start?: string | null
          updated_at?: string | null
          veg_start?: string | null
        }
        Update: {
          actual_end_date?: string | null
          created_at?: string | null
          created_by?: string | null
          current_stage?: string
          cycle_number?: number | null
          dome_start?: string | null
          dry_start?: string | null
          expected_end_date?: string | null
          flower_start?: string | null
          harvest_date?: string | null
          id?: string
          notes?: string | null
          room_id?: string
          start_date?: string
          status?: string
          template_id?: string | null
          trim_start?: string | null
          updated_at?: string | null
          veg_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "room_cycles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_cycles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_cycles_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "grow_rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_cycles_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "cycle_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_tasks: {
        Row: {
          agent_id: string | null
          completed_at: string | null
          created_at: string | null
          customer_id: string | null
          description: string | null
          due_date: string
          id: string
          priority: number | null
          status: string
          title: string
          updated_at: string | null
        }
        Insert: {
          agent_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          customer_id?: string | null
          description?: string | null
          due_date: string
          id?: string
          priority?: number | null
          status?: string
          title: string
          updated_at?: string | null
        }
        Update: {
          agent_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          customer_id?: string | null
          description?: string | null
          due_date?: string
          id?: string
          priority?: number | null
          status?: string
          title?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_tasks_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_tasks_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_tasks_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      sample_requests: {
        Row: {
          contact_name: string
          created_at: string | null
          dispensary_name: string
          email: string
          id: string
          license_number: string
          notes: string | null
          phone: string | null
          status: string | null
          strain_ids: string[] | null
          updated_at: string | null
        }
        Insert: {
          contact_name: string
          created_at?: string | null
          dispensary_name: string
          email: string
          id?: string
          license_number: string
          notes?: string | null
          phone?: string | null
          status?: string | null
          strain_ids?: string[] | null
          updated_at?: string | null
        }
        Update: {
          contact_name?: string
          created_at?: string | null
          dispensary_name?: string
          email?: string
          id?: string
          license_number?: string
          notes?: string | null
          phone?: string | null
          status?: string | null
          strain_ids?: string[] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      sku_materials: {
        Row: {
          created_at: string
          id: string
          material_id: string
          quantity_per_unit: number | null
          sku_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          material_id: string
          quantity_per_unit?: number | null
          sku_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          material_id?: string
          quantity_per_unit?: number | null
          sku_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sku_materials_material_id_fkey"
            columns: ["material_id"]
            isOneToOne: false
            referencedRelation: "materials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_materials_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_materials_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      sku_pricing: {
        Row: {
          created_at: string | null
          id: string
          min_quantity: number
          price: number
          sku_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          min_quantity: number
          price: number
          sku_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          min_quantity?: number
          price?: number
          sku_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sku_pricing_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sku_pricing_sku_id_fkey"
            columns: ["sku_id"]
            isOneToOne: false
            referencedRelation: "skus"
            referencedColumns: ["id"]
          },
        ]
      }
      skus: {
        Row: {
          cbd_percentage: number | null
          code: string
          created_at: string | null
          description: string | null
          grams_per_unit: number
          id: string
          in_stock: boolean
          name: string
          price_per_unit: number | null
          product_type_id: string
          status: string
          strain_id: string
          thc_percentage: number | null
          units_per_case: number
          updated_at: string | null
        }
        Insert: {
          cbd_percentage?: number | null
          code: string
          created_at?: string | null
          description?: string | null
          grams_per_unit: number
          id?: string
          in_stock?: boolean
          name: string
          price_per_unit?: number | null
          product_type_id: string
          status?: string
          strain_id: string
          thc_percentage?: number | null
          units_per_case?: number
          updated_at?: string | null
        }
        Update: {
          cbd_percentage?: number | null
          code?: string
          created_at?: string | null
          description?: string | null
          grams_per_unit?: number
          id?: string
          in_stock?: boolean
          name?: string
          price_per_unit?: number | null
          product_type_id?: string
          status?: string
          strain_id?: string
          thc_percentage?: number | null
          units_per_case?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skus_product_type_id_fkey"
            columns: ["product_type_id"]
            isOneToOne: false
            referencedRelation: "product_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skus_strain_id_fkey"
            columns: ["strain_id"]
            isOneToOne: false
            referencedRelation: "strains"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_agent_log: {
        Row: {
          agent_response: string | null
          cake_user_id: string | null
          channel_id: string
          created_at: string | null
          error: string | null
          id: string
          intent: string | null
          message_text: string | null
          slack_user_id: string
          tool_calls: Json | null
        }
        Insert: {
          agent_response?: string | null
          cake_user_id?: string | null
          channel_id: string
          created_at?: string | null
          error?: string | null
          id?: string
          intent?: string | null
          message_text?: string | null
          slack_user_id: string
          tool_calls?: Json | null
        }
        Update: {
          agent_response?: string | null
          cake_user_id?: string | null
          channel_id?: string
          created_at?: string | null
          error?: string | null
          id?: string
          intent?: string | null
          message_text?: string | null
          slack_user_id?: string
          tool_calls?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "slack_agent_log_cake_user_id_fkey"
            columns: ["cake_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slack_agent_log_cake_user_id_fkey"
            columns: ["cake_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_user_mappings: {
        Row: {
          cake_user_id: string
          created_at: string | null
          id: string
          slack_user_id: string
          slack_username: string | null
          updated_at: string | null
        }
        Insert: {
          cake_user_id: string
          created_at?: string | null
          id?: string
          slack_user_id: string
          slack_username?: string | null
          updated_at?: string | null
        }
        Update: {
          cake_user_id?: string
          created_at?: string | null
          id?: string
          slack_user_id?: string
          slack_username?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "slack_user_mappings_cake_user_id_fkey"
            columns: ["cake_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slack_user_mappings_cake_user_id_fkey"
            columns: ["cake_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      strain_batches: {
        Row: {
          available: boolean | null
          batch_id: string
          cbd_percent: number | null
          coa_url: string | null
          created_at: string | null
          harvest_date: string
          id: string
          strain_id: string | null
          terpenes: Json | null
          thc_percent: number | null
          total_cannabinoids: number | null
        }
        Insert: {
          available?: boolean | null
          batch_id: string
          cbd_percent?: number | null
          coa_url?: string | null
          created_at?: string | null
          harvest_date: string
          id?: string
          strain_id?: string | null
          terpenes?: Json | null
          thc_percent?: number | null
          total_cannabinoids?: number | null
        }
        Update: {
          available?: boolean | null
          batch_id?: string
          cbd_percent?: number | null
          coa_url?: string | null
          created_at?: string | null
          harvest_date?: string
          id?: string
          strain_id?: string | null
          terpenes?: Json | null
          thc_percent?: number | null
          total_cannabinoids?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "strain_batches_strain_id_fkey"
            columns: ["strain_id"]
            isOneToOne: false
            referencedRelation: "strains"
            referencedColumns: ["id"]
          },
        ]
      }
      strain_terpenes: {
        Row: {
          id: string
          percentage: number | null
          sort_order: number | null
          strain_id: string | null
          terpene_name: string
        }
        Insert: {
          id?: string
          percentage?: number | null
          sort_order?: number | null
          strain_id?: string | null
          terpene_name: string
        }
        Update: {
          id?: string
          percentage?: number | null
          sort_order?: number | null
          strain_id?: string | null
          terpene_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "strain_terpenes_strain_id_fkey"
            columns: ["strain_id"]
            isOneToOne: false
            referencedRelation: "strains"
            referencedColumns: ["id"]
          },
        ]
      }
      strains: {
        Row: {
          availability: string | null
          badge: string | null
          cbd_percent: number | null
          coa_url: string | null
          created_at: string | null
          description: string | null
          effects: string | null
          featured: boolean | null
          flavor_notes: string | null
          grow_method: string | null
          harvest_date: string | null
          id: string
          image_url: string | null
          lineage: string | null
          name: string
          slug: string
          sort_order: number | null
          tagline: string | null
          thc_percent: number | null
          type: string
          updated_at: string | null
        }
        Insert: {
          availability?: string | null
          badge?: string | null
          cbd_percent?: number | null
          coa_url?: string | null
          created_at?: string | null
          description?: string | null
          effects?: string | null
          featured?: boolean | null
          flavor_notes?: string | null
          grow_method?: string | null
          harvest_date?: string | null
          id?: string
          image_url?: string | null
          lineage?: string | null
          name: string
          slug: string
          sort_order?: number | null
          tagline?: string | null
          thc_percent?: number | null
          type: string
          updated_at?: string | null
        }
        Update: {
          availability?: string | null
          badge?: string | null
          cbd_percent?: number | null
          coa_url?: string | null
          created_at?: string | null
          description?: string | null
          effects?: string | null
          featured?: boolean | null
          flavor_notes?: string | null
          grow_method?: string | null
          harvest_date?: string | null
          id?: string
          image_url?: string | null
          lineage?: string | null
          name?: string
          slug?: string
          sort_order?: number | null
          tagline?: string | null
          thc_percent?: number | null
          type?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      subscribers: {
        Row: {
          active: boolean | null
          dispensary_name: string | null
          email: string
          id: string
          subscribed_at: string | null
        }
        Insert: {
          active?: boolean | null
          dispensary_name?: string | null
          email: string
          id?: string
          subscribed_at?: string | null
        }
        Update: {
          active?: boolean | null
          dispensary_name?: string | null
          email?: string
          id?: string
          subscribed_at?: string | null
        }
        Relationships: []
      }
      task_notes: {
        Row: {
          created_at: string | null
          id: string
          note: string
          task_key: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          note: string
          task_key: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          note?: string
          task_key?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      template_tasks: {
        Row: {
          created_at: string | null
          day_number: number
          day_of_week: number | null
          description: string | null
          estimated_minutes: number | null
          id: string
          name: string
          priority: string
          sort_order: number | null
          stage: string | null
          template_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          day_number: number
          day_of_week?: number | null
          description?: string | null
          estimated_minutes?: number | null
          id?: string
          name: string
          priority?: string
          sort_order?: number | null
          stage?: string | null
          template_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          day_number?: number
          day_of_week?: number | null
          description?: string | null
          estimated_minutes?: number | null
          id?: string
          name?: string
          priority?: string
          sort_order?: number | null
          stage?: string | null
          template_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "template_tasks_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "cycle_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          amount: number
          created_at: string | null
          id: string
          resulting_balance: number
          tag_id: string
          type: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          id?: string
          resulting_balance: number
          tag_id: string
          type: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          id?: string
          resulting_balance?: number
          tag_id?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["tag_id"]
          },
          {
            foreignKeyName: "transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          auth_id: string | null
          created_at: string | null
          email: string | null
          id: string
          name: string
          pin: string
          role: string
          supabase_auth_id: string | null
        }
        Insert: {
          auth_id?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name: string
          pin: string
          role: string
          supabase_auth_id?: string | null
        }
        Update: {
          auth_id?: string | null
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string
          pin?: string
          role?: string
          supabase_auth_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      products: {
        Row: {
          category: string | null
          cbd_percentage: number | null
          code: string | null
          created_at: string | null
          description: string | null
          grams_per_unit: number | null
          id: string | null
          in_stock: boolean | null
          item_name: string | null
          price_per_unit: number | null
          product_type_id: string | null
          product_type_name: string | null
          status: string | null
          strain_id: string | null
          strain_name: string | null
          strain_raw_name: string | null
          thc_percentage: number | null
          units_per_case: number | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skus_product_type_id_fkey"
            columns: ["product_type_id"]
            isOneToOne: false
            referencedRelation: "product_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skus_strain_id_fkey"
            columns: ["strain_id"]
            isOneToOne: false
            referencedRelation: "strains"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          email: string | null
          full_name: string | null
          id: string | null
          last_login_at: string | null
          login_count: number | null
          pin: string | null
          role: string | null
          supabase_auth_id: string | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: never
          email?: string | null
          full_name?: string | null
          id?: string | null
          last_login_at?: string | null
          login_count?: never
          pin?: string | null
          role?: string | null
          supabase_auth_id?: string | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: never
          email?: string | null
          full_name?: string | null
          id?: string | null
          last_login_at?: string | null
          login_count?: never
          pin?: string | null
          role?: string | null
          supabase_auth_id?: string | null
        }
        Relationships: []
      }
      public_dispensary_locations: {
        Row: {
          address: string | null
          city: string | null
          dispensary_name: string | null
          email: string | null
          omma_license: string | null
          phone: string | null
        }
        Insert: {
          address?: string | null
          city?: string | null
          dispensary_name?: string | null
          email?: string | null
          omma_license?: string | null
          phone?: string | null
        }
        Update: {
          address?: string | null
          city?: string | null
          dispensary_name?: string | null
          email?: string | null
          omma_license?: string | null
          phone?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      calculate_order_commission: {
        Args: { p_order_id: string }
        Returns: number
      }
      get_bank_balance: {
        Args: never
        Returns: {
          account_id: string
          account_name: string
          account_number: string
          as_of_date: string
          available_balance: number
          bank: string
          current_balance: number
          pending_balance: number
        }[]
      }
      get_bank_transactions: {
        Args: { since_date?: string }
        Returns: {
          amount: number
          bs_id: number
          category: string
          description: string
          id: string
          merchant_name: string
          original_description: string
          txn_date: string
          type: string
        }[]
      }
      get_banksync_api_key: { Args: never; Returns: string }
      get_commission_rate:
        | {
            Args: {
              p_date?: string
              p_product_type_id?: string
              p_salesperson_id: string
              p_sku_id?: string
            }
            Returns: number
          }
        | {
            Args: {
              p_date?: string
              p_product_type_id?: string
              p_salesperson_id: string
              p_sku_id?: string
              p_unit_price?: number
            }
            Returns: number
          }
      get_order_commission_breakdown: {
        Args: { p_order_id: string; p_salesperson_id: string }
        Returns: {
          commission_amount: number
          commission_rate: number
          line_total: number
          order_item_id: string
          quantity: number
          sku_code: string
          sku_id: string
          sku_name: string
          unit_price: number
          units_per_case: number
        }[]
      }
      get_untracked_bank_transactions: {
        Args: never
        Returns: {
          amount: number
          bs_id: number
          category: string
          description: string
          id: string
          merchant_name: string
          original_description: string
          txn_date: string
          type: string
        }[]
      }
      reconcile_cleared_checks: {
        Args: never
        Returns: {
          already_paid_count: number
          auto_applied_count: number
          checked_count: number
          mismatch_count: number
          no_bill_match: number
        }[]
      }
      reconcile_non_check_debits: {
        Args: never
        Returns: {
          proposed_count: number
          scanned_count: number
          skipped_count: number
        }[]
      }
      refresh_sku_in_stock_by_id: {
        Args: { p_sku_id: string }
        Returns: undefined
      }
      run_daily_reconciliation: {
        Args: never
        Returns: {
          check_auto_applied: number
          check_mismatch: number
          noncheck_proposed: number
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      sync_bank_snapshot_to_finance: { Args: never; Returns: undefined }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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

export type UserRole = 'agent' | 'management' | 'admin' | 'packaging' | 'vault' | 'grow'
export type TaskStatus = 'pending' | 'complete'
export type OrderStatus = 'pending' | 'confirmed' | 'packed' | 'delivered' | 'cancelled'
export type ContactMethod = 'phone' | 'email' | 'in-person' | 'text'
export type ContactRole = 'owner' | 'manager' | 'inventory_manager' | 'buyer' | 'other'

export type ComplianceReportType =
  | 'plant_movement'
  | 'destruction'
  | 'package_adjustment'
  | 'harvest'
  | 'transfer'
  | 'waste_disposal'
  | 'other'

export interface ComplianceLogEntry {
  id: string
  event_date: string
  logged_by: string
  report_type: ComplianceReportType | string
  custom_report_type?: string | null
  summary: string
  metrc_ids: string[]
  location?: string | null
  witness?: string | null
  metadata: Record<string, any>
  created_at: string
  updated_at: string
  last_edited_by?: string | null
  last_edited_at?: string | null
  is_edited: boolean
  // Joined fields
  logged_by_user?: { id: string; name: string }
  editor?: { id: string; name: string }
}

export interface Profile {
  id: string
  email?: string
  pin?: string
  name: string
  role: UserRole
  created_at: string
  updated_at?: string
}

// Customer (formerly DispensaryProfile)
export interface Customer {
  id: string
  business_name: string
  license_name?: string
  address?: string
  city?: string
  phone_number?: string
  email?: string
  omma_license?: string
  ob_license?: string
  is_active?: boolean
  commission_exempt?: boolean | null
  assigned_sales_id?: string
  has_orders?: boolean
  first_order_date?: string
  last_order_date?: string
  order_count?: number
  created_at: string
  updated_at: string
  // Joined data
  pricing?: CustomerPricing[]
  assigned_sales?: Profile
}

// Customer-specific pricing (by item or category)
// Item-level (sku_id) takes precedence over category-level (product_type_id)
export interface CustomerPricing {
  id: string
  customer_id: string
  sku_id?: string           // For item-specific pricing
  product_type_id?: string  // For category-wide pricing
  price_per_unit: number
  created_at: string
  updated_at: string
  // Joined data for display
  sku?: SKU
  product_type?: ProductType
}

// Alias for backward compatibility during migration
export type DispensaryProfile = Customer

// Contact for a dispensary
export interface Contact {
  id: string
  dispensary_id: string
  name: string
  email?: string
  phone?: string
  role?: ContactRole
  is_primary: boolean
  comm_email: boolean
  comm_sms: boolean
  notes?: string
  created_at: string
  updated_at: string
  // Joined data
  dispensary?: Customer
}

// SKU (finished packaged products)
export interface SKU {
  id: string
  code: string
  name: string
  strain_id: string
  product_type_id: string
  price_per_unit?: number
  grams_per_unit: number
  description?: string
  thc_percentage?: number
  cbd_percentage?: number
  in_stock: boolean
  status?: 'active' | 'staged' | 'discontinued'
  created_at: string
  updated_at: string
  pricing?: SKUPricing[]
}

// Product type - view on skus table
export interface Product {
  id: string
  item_name: string           // Primary field (aliased from skus.name)
  strain_name: string         // Backward compatibility alias
  code: string
  description?: string
  in_stock: boolean
  status?: 'active' | 'staged' | 'discontinued'
  product_type_id?: string
  product_type_name?: string  // Joined from product_types
  units_per_case?: number
  grams_per_unit?: number
  strain_id?: string
  strain_raw_name?: string    // Joined from strains
  created_at: string
  updated_at: string
  // Deprecated fields (still in view for backward compatibility)
  price_per_unit?: number
  thc_percentage?: number
  cbd_percentage?: number
  category?: string           // Alias of product_type_name
  pricing?: ProductPricing[]
}

// Product type for dropdown options
export interface ProductType {
  id: string
  name: string
  created_at: string
}

export interface ProductPricing {
  id: string
  product_id: string
  min_quantity: number
  price: number
  created_at: string
  updated_at: string
}

// SKU Pricing (tiered pricing per SKU)
export interface SKUPricing {
  id: string
  sku_id: string
  min_quantity: number
  price: number
  created_at: string
  updated_at?: string
}

export interface Communication {
  id: string
  agent_id: string
  customer_id: string
  client_name?: string
  interaction_date: string
  notes: string
  contact_method?: ContactMethod
  follow_up_required: boolean
  created_at: string
  updated_at: string
  is_edited?: boolean
  last_edited_at?: string
  last_edited_by?: string
  customer?: Customer
  agent?: Profile
  // Legacy alias
  dispensary?: Customer
}

export interface Task {
  id: string
  agent_id: string
  customer_id?: string
  title: string
  description?: string
  due_date: string
  status: TaskStatus
  priority: number // 1=high, 2=medium, 3=low
  created_at: string
  updated_at: string
  completed_at?: string
  customer?: Customer
  agent?: Profile
  // Legacy alias
  dispensary?: Customer
}

export interface Order {
  id: string
  order_number?: string
  customer_id: string
  agent_id?: string
  order_date: string
  order_notes?: string
  requested_delivery_date?: string
  confirmed_delivery_date?: string
  actual_delivery_date?: string
  packed_at?: string
  delivered_at?: string
  status: OrderStatus
  total_price: number
  approved_by?: string
  approved_at?: string
  created_at: string
  updated_at: string
  last_edited_at?: string
  last_edited_by?: string
  payment_terms?: boolean | null
  terms_payment_date?: string | null
  terms_paid_at?: string | null
  customer?: Customer
  agent?: Profile
  order_items?: OrderItem[]
  // Legacy aliases
  dispensary?: Customer
  dispensary_id?: string
  order_id?: string
  final_delivery_date?: string
}

export interface EditFormData {
  [key: string]: string | number | boolean | Date | null | undefined
}

export interface UpdateData {
  [key: string]: string | number | boolean | Date | null | undefined
}

export interface UserActivity {
  id: string
  user_id: string
  activity_type: string
  activity_description: string
  created_at: string
  metadata?: Record<string, unknown>
}

export interface PermissionUpdate {
  user_id: string
  permissions: Record<string, boolean>
  updated_by: string
}

export interface OrderItem {
  id: string
  order_id: string
  sku_id: string
  quantity: number
  unit_price?: number
  line_total: number
  created_at: string
  sku?: SKU
  // Legacy fields
  product_id?: string
  strain_name?: string
  product?: Product
}

// Commission System
export type CommissionStatus = 'pending' | 'approved' | 'paid'

export interface CommissionRate {
  id: string
  salesperson_id?: string
  product_type_id?: string
  sku_id?: string
  min_unit_price?: number  // Price tier threshold (NULL = floor/default rate)
  rate_percent: number
  effective_from: string
  effective_to?: string
  created_at: string
  updated_at: string
  // Joined data
  salesperson?: Profile
  product_type?: ProductType
  sku?: SKU
}

export interface Commission {
  id: string
  order_id: string
  salesperson_id: string
  order_date: string
  order_total: number
  commission_amount: number
  rate_applied: number
  status: CommissionStatus
  paid_at?: string
  paid_by?: string
  notes?: string
  created_at: string
  updated_at: string
  // Joined data
  order?: Order
  salesperson?: Profile
  paid_by_user?: Profile
}
