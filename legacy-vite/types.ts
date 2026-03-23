import React from 'react';

export type ProvisionStatus = 'Pending' | 'Ordered' | 'Completed' | 'Cancelled';

export interface Provision {
  id: string; // PROV-YYYYMMDD-SEQ
  oem_name: string;
  product_model: string;
  quantity: number;
  unit_price: number;
  total_value: number;
  status: ProvisionStatus;
  created_at: string;
  expected_delivery_date?: string;
  notes?: string;
}

export type LeadStatus = 'New' | 'Qualified' | 'Unqualified' | 'Converted' | 'AI_In_Progress';
export type BolnaQualificationStatus = 'not_started' | 'in_progress' | 'completed';

export interface Lead {
  id: string; // LEAD-YYYYMMDD-SEQ
  name: string;
  phone: string;
  source: string; // Manual, Bolna Inbound, Call Center, Digital, Referral
  status: LeadStatus;
  score: number;
  last_activity: string;

  // Bolna.ai Integration Fields (SOP 12.3)
  total_bolna_calls: number;
  bolna_qualification_status: BolnaQualificationStatus;
  highest_phase_reached?: string;
  ai_engagement_score?: number; // 0-100
}

export interface BolnaCall {
  id: string; // CALL-YYYYMMDD-SEQ
  lead_name: string;
  phone_number: string;
  status: 'initiated' | 'in_progress' | 'paused' | 'completed' | 'failed';
  current_phase: string;
  initiated_at: string;
  duration_seconds: number;
  cost_rupees: number;
  sentiment_score: number; // -1 to 1
  summary?: string;
}

export interface Order {
  id: string; // ORD-YYYYMMDD-SEQ
  provision_id: string;
  oem: string;
  amount: number;
  status: 'Draft' | 'Sent' | 'Confirmed' | 'Delivered';
  date: string;
  items: number;
}

export interface Invoice {
  id: string; // INV-YYYYMMDD-SEQ
  order_id: string;
  amount: number;
  status: 'Paid' | 'Unpaid' | 'Overdue';
  due_date: string;
  oem: string;
}

export interface Conversion {
  id: string; // CONV-YYYYMMDD-SEQ
  lead_name: string;
  value: number;
  date: string;
  product: string;
  source: string;
}

export interface KPIMetric {
  label: string;
  value: string | number;
  subValue?: string;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  color?: 'primary' | 'pink' | 'purple' | 'yellow' | 'blue';
  icon?: React.ReactNode;
}

// Authentication Types
export type UserRole = 'sales_head' | 'ceo' | 'sales_manager' | 'dealer';

export interface User {
  id: string;
  email: string;
  full_name: string;
  phone?: string;
  roles: UserRole[];
  created_at: string;
}

export interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  hasRole: (role: UserRole) => boolean;
  hasPermission: (permission: string) => boolean;
}

export interface DealerProfile {
  user_id: string;
  dealer_code: string;
  company_name: string;
  gst_number?: string;
}

export interface SalesManagerProfile {
  user_id: string;
  manager_code: string;
  region?: string;
}