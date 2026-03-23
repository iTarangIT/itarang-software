import { Lead, Provision, Order, Invoice, BolnaCall, Conversion } from './types';
import { Truck, Package, CheckCircle } from 'lucide-react';
import React from 'react';

export const MOCK_PROVISIONS: Provision[] = [
  { 
    id: 'PROV-20260115-001', 
    oem_name: 'Livguard', 
    product_model: '48V 40Ah', 
    quantity: 50, 
    unit_price: 12000, 
    total_value: 600000, 
    status: 'Pending', 
    created_at: '2026-01-15',
    expected_delivery_date: '2026-02-01'
  },
  { 
    id: 'PROV-20260114-002', 
    oem_name: 'Exide', 
    product_model: '60V 30Ah', 
    quantity: 100, 
    unit_price: 15000, 
    total_value: 1500000, 
    status: 'Ordered', 
    created_at: '2026-01-14',
    expected_delivery_date: '2026-01-28'
  },
  { 
    id: 'PROV-20260113-003', 
    oem_name: 'Amaron', 
    product_model: '72V 50Ah', 
    quantity: 25, 
    unit_price: 22000, 
    total_value: 550000, 
    status: 'Completed', 
    created_at: '2026-01-13' 
  },
  { 
    id: 'PROV-20260112-004', 
    oem_name: 'Livguard', 
    product_model: '48V 26Ah', 
    quantity: 200, 
    unit_price: 9000, 
    total_value: 1800000, 
    status: 'Ordered', 
    created_at: '2026-01-12',
    expected_delivery_date: '2026-01-25'
  },
  { 
    id: 'PROV-20260111-005', 
    oem_name: 'Exide', 
    product_model: '48V 40Ah', 
    quantity: 10, 
    unit_price: 12500, 
    total_value: 125000, 
    status: 'Cancelled', 
    created_at: '2026-01-11' 
  },
];

export const MOCK_LEADS: Lead[] = [
  { 
    id: 'LEAD-20260115-001', 
    name: 'Rahul Sharma', 
    phone: '+91 98765 43210', 
    source: 'Digital', 
    status: 'New', 
    score: 20, 
    last_activity: '2 hours ago',
    total_bolna_calls: 0,
    bolna_qualification_status: 'not_started'
  },
  { 
    id: 'LEAD-20260115-002', 
    name: 'Priya Verma', 
    phone: '+91 99887 76655', 
    source: 'Call Center', 
    status: 'AI_In_Progress', 
    score: 45, 
    last_activity: '10 mins ago',
    total_bolna_calls: 2,
    bolna_qualification_status: 'in_progress',
    highest_phase_reached: 'Product Discovery',
    ai_engagement_score: 78
  },
  { 
    id: 'LEAD-20260114-003', 
    name: 'Amit Kumar', 
    phone: '+91 88776 65544', 
    source: 'Referral', 
    status: 'Qualified', 
    score: 85, 
    last_activity: '1 day ago',
    total_bolna_calls: 1,
    bolna_qualification_status: 'completed',
    highest_phase_reached: 'Transaction',
    ai_engagement_score: 92
  },
  { 
    id: 'LEAD-20260114-004', 
    name: 'Sneha Gupta', 
    phone: '+91 77665 54433', 
    source: 'Digital', 
    status: 'Unqualified', 
    score: 10, 
    last_activity: '1 day ago',
    total_bolna_calls: 1,
    bolna_qualification_status: 'completed',
    highest_phase_reached: 'Product Information Discovery',
    ai_engagement_score: 30
  },
  { 
    id: 'LEAD-20260113-005', 
    name: 'Vikram Singh', 
    phone: '+91 66554 43322', 
    source: 'Bolna Inbound', 
    status: 'Converted', 
    score: 95, 
    last_activity: '2 days ago',
    total_bolna_calls: 3,
    bolna_qualification_status: 'completed',
    highest_phase_reached: 'Feedback',
    ai_engagement_score: 98
  },
];

export const MOCK_ORDERS: Order[] = [
  { id: 'ORD-20260114-001', provision_id: 'PROV-20260114-002', oem: 'Exide', amount: 1500000, status: 'Confirmed', date: '2026-01-14', items: 100 },
  { id: 'ORD-20260112-002', provision_id: 'PROV-20260112-004', oem: 'Livguard', amount: 1800000, status: 'Sent', date: '2026-01-12', items: 200 },
  { id: 'ORD-20260110-003', provision_id: 'PROV-20260110-001', oem: 'Amaron', amount: 450000, status: 'Delivered', date: '2026-01-10', items: 50 },
];

export const MOCK_INVOICES: Invoice[] = [
  { id: 'INV-20260114-001', order_id: 'ORD-20260114-001', oem: 'Exide', amount: 1500000, status: 'Unpaid', due_date: '2026-02-14' },
  { id: 'INV-20260112-002', order_id: 'ORD-20260112-002', oem: 'Livguard', amount: 1800000, status: 'Paid', due_date: '2026-02-12' },
  { id: 'INV-20260110-003', order_id: 'ORD-20260110-003', oem: 'Amaron', amount: 450000, status: 'Overdue', due_date: '2026-01-25' },
];

export const MOCK_CALL_LOGS: BolnaCall[] = [
  { 
    id: 'CALL-20260115-001', 
    lead_name: 'Priya Verma', 
    phone_number: '+91 99887 76655', 
    initiated_at: '2026-01-15 10:30 AM', 
    duration_seconds: 252, 
    status: 'completed', 
    current_phase: 'Visit Scheduling',
    sentiment_score: 0.8, 
    cost_rupees: 12.50,
    summary: 'Interested in 48V model, scheduled demo.' 
  },
  { 
    id: 'CALL-20260115-002', 
    lead_name: 'Rajesh Koothrappali', 
    phone_number: '+91 98989 89898', 
    initiated_at: '2026-01-15 11:15 AM', 
    duration_seconds: 45, 
    status: 'failed', 
    current_phase: 'Product Information Discovery',
    sentiment_score: 0.1, 
    cost_rupees: 2.50,
    summary: 'No answer, left voicemail.' 
  },
  { 
    id: 'CALL-20260114-003', 
    lead_name: 'Sneha Gupta', 
    phone_number: '+91 77665 54433', 
    initiated_at: '2026-01-14 02:20 PM', 
    duration_seconds: 150, 
    status: 'completed', 
    current_phase: 'Product Discovery',
    sentiment_score: -0.4, 
    cost_rupees: 8.00,
    summary: 'Price point too high, looking for cheaper alternatives.' 
  },
  { 
    id: 'CALL-20260113-004', 
    lead_name: 'Vikram Singh', 
    phone_number: '+91 66554 43322', 
    initiated_at: '2026-01-13 09:45 AM', 
    duration_seconds: 350, 
    status: 'completed', 
    current_phase: 'Transaction',
    sentiment_score: 0.9, 
    cost_rupees: 18.00,
    summary: 'Highly interested, discussed bulk order terms.' 
  },
];

export const MOCK_CONVERSIONS: Conversion[] = [
  { id: 'CONV-20260113-001', lead_name: 'Vikram Singh', product: 'Fleet Order (50x)', value: 600000, date: '2026-01-13', source: 'Bolna AI' },
  { id: 'CONV-20260114-002', lead_name: 'Amit Kumar', product: '48V 40Ah', value: 12000, date: '2026-01-14', source: 'Referral' },
  { id: 'CONV-20260112-003', lead_name: 'Suresh Raina', product: '60V 30Ah', value: 15000, date: '2026-01-12', source: 'Digital' },
];

export const DASHBOARD_STATS = [
  {
    label: 'Revenue This Month',
    value: '₹12.4L',
    subValue: 'Target: ₹15L',
    trend: 'up',
    trendValue: '12.4%',
    color: 'pink',
    icon: <Truck className="w-6 h-6 text-pink-600" />
  },
  {
    label: 'Total Provisions',
    value: '320',
    subValue: '25 Pending',
    trend: 'up',
    trendValue: '10.4%',
    color: 'purple',
    icon: <Package className="w-6 h-6 text-purple-600" />
  },
  {
    label: 'Active AI Calls',
    value: '1,327',
    subValue: 'High Success Rate',
    trend: 'up',
    trendValue: '2.4%',
    color: 'primary', 
    icon: <CheckCircle className="w-6 h-6 text-primary-600" />
  }
];

export const AI_TRANSCRIPT_MOCK = [
  { speaker: 'AI', text: "Hello! I'm calling from iTarang Technologies. Am I speaking with Mr. Verma?" },
  { speaker: 'Customer', text: "Yes, this is him." },
  { speaker: 'AI', text: "Great. I noticed you showed interest in our e-rickshaw batteries. Could you tell me what brand you are currently using?" },
  { speaker: 'Customer', text: "I'm using a local brand, but it discharges too quickly." },
  { speaker: 'AI', text: "I understand. That's a common issue. We have a 48V 40Ah model specifically designed for long life. Would you be interested in a demo?" },
  { speaker: 'Customer', text: "What is the price range?" },
  { speaker: 'AI', text: "It starts around ₹12,000 with a 3-year warranty. We also offer EMI options. Does that sound within your budget?" },
  { speaker: 'Customer', text: "Yes, EMI would be good." },
  { speaker: 'AI', text: "Perfect. Let me note that down. I'll have a senior sales representative visit you for the demo. Is tomorrow morning 10 AM good?" },
];