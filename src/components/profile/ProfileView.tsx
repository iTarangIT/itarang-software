'use client';

// The profile body, shared by /profile, /nbfc/profile and /risk-head/profile.
//
// It replaces a page that read a stale localStorage["dealerDashboardData"] blob
// and hardcoded dealer@itarang.com / "Dealer" / "Not Set" — so every role saw a
// dealer account that wasn't theirs. Everything here comes from the session:
// core fields from useAuth() (already cached, renders instantly) and the
// role-specific card from /api/user/profile/details behind its own skeleton.
//
// Styling follows the BRD §6.B brand system (globals.css): navy/teal/royal/sky
// gradient chrome, white cards on --color-bg, DM Mono for IDs. Nothing here
// invents a field — anything the session doesn't know renders as "Not set"
// rather than a plausible-looking placeholder.

import { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    BadgeCheck,
    Building2,
    CalendarDays,
    Check,
    Copy,
    CreditCard,
    Fingerprint,
    Landmark,
    Mail,
    MapPin,
    Phone,
    Recycle,
    Shield,
    ShieldCheck,
    Sparkles,
    User,
} from 'lucide-react';
import { useAuth } from '@/components/auth/AuthProvider';
import { useUIStore } from '@/store/uiStore';

type Details =
    | { kind: 'none' }
    | {
          kind: 'dealer';
          dealer: {
              dealerId: string | null;
              companyName: string | null;
              companyType: string | null;
              dealerType: string | null;
              gstNumber: string | null;
              panNumber: string | null;
              financeEnabled: boolean;
              onboardingStatus: string | null;
              reviewStatus: string | null;
              city: string | null;
              state: string | null;
              submittedAt: string | null;
              approvedAt: string | null;
          };
      }
    | {
          kind: 'nbfc';
          nbfc: {
              tenantId: string;
              displayName: string;
              contactEmail: string | null;
              nbfcRole: string | null;
              nbfcRoleLabel: string | null;
          };
      }
    | {
          kind: 'vendor';
          vendor: {
              entityId: string;
              businessName: string | null;
              gstin: string | null;
              city: string | null;
              state: string | null;
              categories: string[];
              regions: string[];
              paymentTerms: string | null;
              active: boolean;
          };
      };

// snake_case → Title Case, with overrides for the ones that would otherwise
// read badly ("Nbfc Partner", "Ceo").
const ROLE_LABELS: Record<string, string> = {
    ceo: 'CEO',
    nbfc_partner: 'NBFC Partner',
    nbfc_risk_head: 'Risk Head',
    scrap_vendor: 'Scrap Vendor',
    asm: 'ASM',
    admin: 'Admin',
};

function formatRole(role?: string | null): string {
    if (!role) return 'User';
    const key = role.toLowerCase();
    if (ROLE_LABELS[key]) return ROLE_LABELS[key];
    return key
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function titleCase(value?: string | null): string | null {
    if (!value) return null;
    return value
        .replace(/[_-]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

function formatDate(value?: string | null): string {
    if (!value) return 'Not available';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'Not available';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function initialsOf(name?: string | null, email?: string | null): string {
    const source = (name || email?.split('@')[0] || 'U').trim();
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
}

const CARD =
    'rounded-3xl border border-[color:var(--color-border)] bg-white shadow-[var(--shadow-soft)]';

/** Semantic tone for a free-text workflow status (onboarding / review). */
function statusTone(value?: string | null): 'success' | 'warning' | 'danger' | 'neutral' {
    const v = (value || '').toLowerCase();
    if (!v) return 'neutral';
    if (/(approved|active|completed|verified|success)/.test(v)) return 'success';
    if (/(reject|fail|suspend|blocked|inactive)/.test(v)) return 'danger';
    if (/(pending|review|submitted|progress|draft|awaiting)/.test(v)) return 'warning';
    return 'neutral';
}

const TONE_CLASS: Record<string, string> = {
    success: 'bg-[color:var(--color-success-bg)] text-[color:var(--color-success)]',
    warning: 'bg-[color:var(--color-warning-bg)] text-[color:var(--color-warning)]',
    danger: 'bg-[color:var(--color-danger-bg)] text-[color:var(--color-danger)]',
    neutral: 'bg-slate-100 text-slate-600',
};

function StatusPill({ value, label }: { value?: string | null; label?: string }) {
    const text = label ?? titleCase(value) ?? 'Not available';
    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                TONE_CLASS[statusTone(value)]
            }`}
        >
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
            {text}
        </span>
    );
}

/** A labelled value inside a role card. `mono` for IDs, GSTINs, PANs. */
function Field({
    label,
    value,
    mono = false,
}: {
    label: string;
    value: React.ReactNode;
    mono?: boolean;
}) {
    return (
        <div className="group rounded-2xl border border-transparent bg-[color:var(--color-bg)] p-4 transition-colors duration-150 hover:border-brand-100 hover:bg-brand-50/60">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-ink-muted)]">
                {label}
            </p>
            <div
                className={`mt-1.5 break-words text-[15px] font-semibold text-[color:var(--color-brand-navy)] ${
                    mono ? 'font-mono text-sm tracking-tight' : ''
                }`}
            >
                {value}
            </div>
        </div>
    );
}

/** A contact row with an icon chip — used for the core identity block. */
function IconField({
    icon,
    label,
    value,
    action,
}: {
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div className="group flex items-start gap-4 rounded-2xl border border-transparent bg-[color:var(--color-bg)] p-4 transition-all duration-150 hover:border-brand-100 hover:bg-brand-50/60">
            <div className="rounded-xl bg-white p-2.5 text-[color:var(--color-brand-sky)] shadow-[var(--shadow-card)] transition-transform duration-150 group-hover:-translate-y-0.5">
                {icon}
            </div>
            <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--color-ink-muted)]">
                    {label}
                </p>
                <div className="mt-1 flex items-center gap-2 break-words text-[15px] font-semibold text-[color:var(--color-brand-navy)]">
                    {value}
                    {action}
                </div>
            </div>
        </div>
    );
}

/** Card header: tinted icon tile + title + one line of context. */
function SectionHeader({
    icon,
    title,
    subtitle,
    tint,
}: {
    icon: React.ReactNode;
    title: string;
    subtitle: string;
    tint: string;
}) {
    return (
        <div className="mb-6 flex items-center gap-3">
            <div className={`rounded-2xl p-3 ${tint}`}>{icon}</div>
            <div>
                <h3 className="text-lg font-bold text-[color:var(--color-brand-navy)]">{title}</h3>
                <p className="text-sm text-[color:var(--color-ink-muted)]">{subtitle}</p>
            </div>
        </div>
    );
}

/** Glass tile in the hero band. */
function HeroStat({
    icon,
    label,
    value,
}: {
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
}) {
    return (
        <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-sm">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                {icon}
                {label}
            </p>
            <div className="mt-1 truncate text-sm font-semibold text-white">{value}</div>
        </div>
    );
}

function Chip({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-semibold text-[color:var(--color-brand-700)]">
            {children}
        </span>
    );
}

export default function ProfileView() {
    const { user, loading } = useAuth();
    const openChangePassword = useUIStore((s) => s.openChangePassword);

    const [details, setDetails] = useState<Details | null>(null);
    const [detailsLoading, setDetailsLoading] = useState(true);
    const [copied, setCopied] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/user/profile/details', {
                    cache: 'no-store',
                    credentials: 'include',
                });
                const json = await res.json().catch(() => null);
                if (cancelled) return;
                setDetails(res.ok && json?.data ? (json.data as Details) : { kind: 'none' });
            } catch {
                if (!cancelled) setDetails({ kind: 'none' });
            } finally {
                if (!cancelled) setDetailsLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const copy = async (key: string, value?: string | null) => {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            setCopied(key);
            setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
        } catch {
            /* clipboard blocked — nothing useful to say */
        }
    };

    // The one-line organisation subtitle under the name in the hero. Only shown
    // when the details fetch actually resolved an entity for this user.
    const orgLine = useMemo(() => {
        if (!details) return null;
        if (details.kind === 'dealer') return details.dealer.companyName;
        if (details.kind === 'nbfc') return details.nbfc.displayName;
        if (details.kind === 'vendor') return details.vendor.businessName;
        return null;
    }, [details]);

    if (loading && !user) {
        return (
            <div className="space-y-6 pb-12">
                <div className="h-9 w-56 animate-pulse rounded-lg bg-slate-200" />
                <div className="h-56 animate-pulse rounded-3xl bg-slate-200/70" />
                <div className="grid gap-6 lg:grid-cols-3">
                    <div className="h-72 animate-pulse rounded-3xl bg-slate-100 lg:col-span-2" />
                    <div className="h-72 animate-pulse rounded-3xl bg-slate-100" />
                </div>
            </div>
        );
    }

    if (!user) {
        return (
            <div className="space-y-3 pb-10">
                <h1 className="text-3xl font-bold text-[color:var(--color-brand-navy)]">My Profile</h1>
                <p className="text-[color:var(--color-ink-muted)]">You are not signed in.</p>
            </div>
        );
    }

    const displayName = user.name || user.email?.split('@')[0] || 'User';
    const roleLabel =
        details?.kind === 'nbfc'
            ? details.nbfc.nbfcRoleLabel || details.nbfc.nbfcRole || formatRole(user.role)
            : formatRole(user.role);

    return (
        <div className="pb-12">
            {/* Page heading */}
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-[color:var(--color-brand-navy)]">
                        My Profile
                    </h1>
                    <p className="mt-1.5 text-[15px] text-[color:var(--color-ink-muted)]">
                        View and manage your account settings
                    </p>
                </div>
                <button
                    type="button"
                    onClick={openChangePassword}
                    className="btn-secondary"
                >
                    <ShieldCheck className="h-4 w-4" />
                    Change Password
                </button>
            </div>

            {/* ---------------------------------------------------------------
                Hero — brand gradient band with the identity summary. The soft
                radial highlights are decorative only (aria-hidden).
               --------------------------------------------------------------- */}
            <section
                className="relative mt-6 overflow-hidden rounded-3xl shadow-[var(--shadow-pop)]"
                style={{ background: 'var(--gradient-primary)' }}
            >
                <div
                    aria-hidden
                    className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full opacity-40 blur-3xl"
                    style={{ background: 'radial-gradient(circle, #7fd0f5 0%, transparent 70%)' }}
                />
                <div
                    aria-hidden
                    className="pointer-events-none absolute -bottom-32 left-1/3 h-72 w-72 rounded-full opacity-30 blur-3xl"
                    style={{ background: 'radial-gradient(circle, #02314e 0%, transparent 70%)' }}
                />

                <div className="relative px-6 py-8 sm:px-9 sm:py-10">
                    <div className="flex flex-col gap-7 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                            {/* Avatar — real image when the account has one. */}
                            <div className="relative shrink-0">
                                <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-3xl border border-white/25 bg-white/15 text-3xl font-bold text-white shadow-lg backdrop-blur">
                                    {user.avatar_url ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={user.avatar_url}
                                            alt=""
                                            className="h-full w-full object-cover"
                                        />
                                    ) : (
                                        initialsOf(user.name, user.email)
                                    )}
                                </div>
                                {user.is_active && (
                                    <span
                                        aria-hidden
                                        className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white/70 bg-emerald-500 shadow"
                                    >
                                        <Check className="h-4 w-4 text-white" strokeWidth={3} />
                                    </span>
                                )}
                            </div>

                            <div className="min-w-0">
                                <h2 className="truncate text-3xl font-bold text-white sm:text-[2rem]">
                                    {displayName}
                                </h2>
                                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-white/85">
                                    <span className="font-semibold">{roleLabel}</span>
                                    {orgLine && (
                                        <>
                                            <span aria-hidden className="text-white/40">
                                                •
                                            </span>
                                            <span className="truncate">{orgLine}</span>
                                        </>
                                    )}
                                </p>

                                <div className="mt-4 flex flex-wrap items-center gap-2">
                                    {/* Only rendered when we actually know — the synthetic
                                        fallback user has no is_active, and asserting "Active"
                                        for an unknown state is the exact class of lie this
                                        page previously told. */}
                                    {user.is_active !== undefined && (
                                        <span
                                            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold backdrop-blur ${
                                                user.is_active
                                                    ? 'bg-emerald-400/20 text-emerald-50'
                                                    : 'bg-rose-400/25 text-rose-50'
                                            }`}
                                        >
                                            <BadgeCheck className="h-4 w-4" />
                                            {user.is_active ? 'Active' : 'Inactive'}
                                        </span>
                                    )}
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-3.5 py-1.5 text-sm font-semibold text-white/90 backdrop-blur">
                                        <Mail className="h-4 w-4" />
                                        <span className="truncate">{user.email}</span>
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Summary tiles */}
                        <div className="grid w-full shrink-0 grid-cols-1 gap-3 sm:grid-cols-3 lg:w-auto lg:max-w-md">
                            <HeroStat
                                icon={<CalendarDays className="h-3 w-3" />}
                                label="Member Since"
                                value={formatDate(user.created_at)}
                            />
                            <HeroStat
                                icon={<Shield className="h-3 w-3" />}
                                label="Access Level"
                                value={formatRole(user.role)}
                            />
                            <HeroStat
                                icon={<Sparkles className="h-3 w-3" />}
                                label="Last Updated"
                                value={formatDate(user.updated_at)}
                            />
                        </div>
                    </div>
                </div>
            </section>

            {/* --------------------------------------------------------------- */}
            <div className="mt-6 grid gap-6 lg:grid-cols-3">
                {/* Left column — identity + role entity */}
                <div className="space-y-6 lg:col-span-2">
                    <div className={`${CARD} p-6 sm:p-7`}>
                        <SectionHeader
                            icon={<User className="h-5 w-5" />}
                            title="Personal Information"
                            subtitle="How your account identifies you across iTarang"
                            tint="bg-brand-50 text-[color:var(--color-brand-sky)]"
                        />
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <IconField
                                icon={<User className="h-4.5 w-4.5" />}
                                label="Full Name"
                                value={user.name || 'Not set'}
                            />
                            <IconField
                                icon={<Mail className="h-4.5 w-4.5" />}
                                label="Email"
                                value={<span className="truncate">{user.email}</span>}
                                action={
                                    <CopyButton
                                        active={copied === 'email'}
                                        onClick={() => copy('email', user.email)}
                                        label="Copy email"
                                    />
                                }
                            />
                            <IconField
                                icon={<Phone className="h-4.5 w-4.5" />}
                                label="Phone"
                                value={user.phone || 'Not set'}
                            />
                            <IconField
                                icon={<Shield className="h-4.5 w-4.5" />}
                                label="Role"
                                value={roleLabel}
                            />
                            <div className="md:col-span-2">
                                <IconField
                                    icon={<Fingerprint className="h-4.5 w-4.5" />}
                                    label="Account ID"
                                    value={
                                        <span className="truncate font-mono text-xs tracking-tight text-[color:var(--color-ink-muted)]">
                                            {user.id}
                                        </span>
                                    }
                                    action={
                                        <CopyButton
                                            active={copied === 'id'}
                                            onClick={() => copy('id', user.id)}
                                            label="Copy account ID"
                                        />
                                    }
                                />
                            </div>
                        </div>
                    </div>

                    {/* Role-specific card */}
                    {detailsLoading ? (
                        <div className={`${CARD} p-6 sm:p-7`}>
                            <div className="mb-6 flex items-center gap-3">
                                <div className="h-11 w-11 animate-pulse rounded-2xl bg-slate-100" />
                                <div className="space-y-2">
                                    <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
                                    <div className="h-3 w-28 animate-pulse rounded bg-slate-100" />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                {[0, 1, 2, 3].map((i) => (
                                    <div key={i} className="h-20 animate-pulse rounded-2xl bg-slate-100" />
                                ))}
                            </div>
                        </div>
                    ) : details?.kind === 'dealer' ? (
                        <div className={`${CARD} p-6 sm:p-7`}>
                            <SectionHeader
                                icon={<Building2 className="h-5 w-5" />}
                                title="Company Details"
                                subtitle="Your dealership record"
                                tint="bg-violet-50 text-violet-600"
                            />
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <Field
                                    label="Company Name"
                                    value={details.dealer.companyName || 'Not available'}
                                />
                                <Field
                                    label="Dealer ID"
                                    value={details.dealer.dealerId || 'Not generated'}
                                    mono={Boolean(details.dealer.dealerId)}
                                />
                                <Field
                                    label="Company Type"
                                    value={titleCase(details.dealer.companyType) || 'Not available'}
                                />
                                <Field
                                    label="Dealer Type"
                                    value={titleCase(details.dealer.dealerType) || 'Not available'}
                                />
                                <Field
                                    label="GST Number"
                                    value={details.dealer.gstNumber || 'Not available'}
                                    mono={Boolean(details.dealer.gstNumber)}
                                />
                                <Field
                                    label="PAN Number"
                                    value={details.dealer.panNumber || 'Not available'}
                                    mono={Boolean(details.dealer.panNumber)}
                                />
                                <Field
                                    label="Location"
                                    value={
                                        [details.dealer.city, details.dealer.state]
                                            .filter(Boolean)
                                            .join(', ') || 'Not available'
                                    }
                                />
                                <Field
                                    label="Finance Enabled"
                                    value={
                                        <StatusPill
                                            value={details.dealer.financeEnabled ? 'active' : 'inactive'}
                                            label={details.dealer.financeEnabled ? 'Enabled' : 'Disabled'}
                                        />
                                    }
                                />
                                <Field
                                    label="Onboarding Status"
                                    value={
                                        details.dealer.onboardingStatus ? (
                                            <StatusPill value={details.dealer.onboardingStatus} />
                                        ) : (
                                            'Not available'
                                        )
                                    }
                                />
                                <Field label="Approved On" value={formatDate(details.dealer.approvedAt)} />
                            </div>
                        </div>
                    ) : details?.kind === 'nbfc' ? (
                        <div className={`${CARD} p-6 sm:p-7`}>
                            <SectionHeader
                                icon={<Landmark className="h-5 w-5" />}
                                title="NBFC Organisation"
                                subtitle="The lender you act for"
                                tint="bg-brand-50 text-[color:var(--color-brand-royal)]"
                            />
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <Field label="NBFC" value={details.nbfc.displayName} />
                                <Field
                                    label="Your Role"
                                    value={
                                        details.nbfc.nbfcRoleLabel ||
                                        titleCase(details.nbfc.nbfcRole) ||
                                        'Not assigned'
                                    }
                                />
                                <Field
                                    label="Contact Email"
                                    value={details.nbfc.contactEmail || 'Not available'}
                                />
                                <Field label="Tenant ID" value={details.nbfc.tenantId} mono />
                            </div>
                        </div>
                    ) : details?.kind === 'vendor' ? (
                        <div className={`${CARD} p-6 sm:p-7`}>
                            <SectionHeader
                                icon={<Recycle className="h-5 w-5" />}
                                title="Vendor Details"
                                subtitle="Your scrap vendor account"
                                tint="bg-emerald-50 text-emerald-600"
                            />
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <Field
                                    label="Business Name"
                                    value={details.vendor.businessName || 'Not available'}
                                />
                                <Field
                                    label="GSTIN"
                                    value={details.vendor.gstin || 'Not available'}
                                    mono={Boolean(details.vendor.gstin)}
                                />
                                <Field
                                    label="Location"
                                    value={
                                        [details.vendor.city, details.vendor.state]
                                            .filter(Boolean)
                                            .join(', ') || 'Not available'
                                    }
                                />
                                <Field
                                    label="Status"
                                    value={
                                        <StatusPill
                                            value={details.vendor.active ? 'active' : 'inactive'}
                                        />
                                    }
                                />
                                <Field
                                    label="Payment Terms"
                                    value={titleCase(details.vendor.paymentTerms) || 'Not set'}
                                />
                                <Field
                                    label="Categories"
                                    value={
                                        details.vendor.categories.length ? (
                                            <span className="flex flex-wrap gap-1.5">
                                                {details.vendor.categories.map((c) => (
                                                    <Chip key={c}>{titleCase(c)}</Chip>
                                                ))}
                                            </span>
                                        ) : (
                                            'Not set'
                                        )
                                    }
                                />
                                <div className="md:col-span-2">
                                    <Field
                                        label="Regions"
                                        value={
                                            details.vendor.regions.length ? (
                                                <span className="flex flex-wrap gap-1.5">
                                                    {details.vendor.regions.map((r) => (
                                                        <Chip key={r}>{titleCase(r)}</Chip>
                                                    ))}
                                                </span>
                                            ) : (
                                                'Not set'
                                            )
                                        }
                                    />
                                </div>
                            </div>
                        </div>
                    ) : null}
                </div>

                {/* Right column — security + account meta */}
                <div className="space-y-6">
                    <div className={`${CARD} p-6 sm:p-7`}>
                        <SectionHeader
                            icon={<ShieldCheck className="h-5 w-5" />}
                            title="Security"
                            subtitle="Password and account access"
                            tint="bg-brand-50 text-[color:var(--color-brand-teal)]"
                        />

                        {user.must_change_password && (
                            <div className="mb-4 flex gap-3 rounded-2xl bg-[color:var(--color-warning-bg)] p-4">
                                <AlertTriangle className="h-5 w-5 shrink-0 text-[color:var(--color-warning)]" />
                                <p className="text-sm font-medium text-[color:var(--color-warning)]">
                                    A password change is required on this account.
                                </p>
                            </div>
                        )}

                        <div className="rounded-2xl bg-[color:var(--color-bg)] p-5">
                            <div className="flex items-center gap-3">
                                <div className="rounded-xl bg-white p-2.5 text-[color:var(--color-brand-sky)] shadow-[var(--shadow-card)]">
                                    <CreditCard className="h-4.5 w-4.5" />
                                </div>
                                <div>
                                    <p className="text-[15px] font-semibold text-[color:var(--color-brand-navy)]">
                                        Password
                                    </p>
                                    <p className="text-sm text-[color:var(--color-ink-muted)]">
                                        Verified by email code
                                    </p>
                                </div>
                            </div>
                            <p className="mt-4 text-sm leading-relaxed text-[color:var(--color-ink-muted)]">
                                We&apos;ll email a one-time code to{' '}
                                <span className="font-semibold text-[color:var(--color-brand-navy)]">
                                    {user.email}
                                </span>{' '}
                                to confirm the change.
                            </p>
                            <button
                                type="button"
                                onClick={openChangePassword}
                                className="btn-primary mt-5 w-full"
                            >
                                Change Password
                            </button>
                        </div>
                    </div>

                    <div className={`${CARD} p-6 sm:p-7`}>
                        <SectionHeader
                            icon={<BadgeCheck className="h-5 w-5" />}
                            title="Account"
                            subtitle="Status and lifecycle"
                            tint="bg-slate-100 text-slate-600"
                        />
                        <dl className="divide-y divide-[color:var(--color-border)]">
                            <MetaRow
                                label="Status"
                                value={
                                    user.is_active === undefined ? (
                                        <span className="text-[color:var(--color-ink-muted)]">Unknown</span>
                                    ) : (
                                        <StatusPill value={user.is_active ? 'active' : 'inactive'} />
                                    )
                                }
                            />
                            <MetaRow label="Access Level" value={formatRole(user.role)} />
                            <MetaRow label="Member Since" value={formatDate(user.created_at)} />
                            <MetaRow label="Last Updated" value={formatDate(user.updated_at)} />
                            {details?.kind === 'dealer' && details.dealer.city && (
                                <MetaRow
                                    label="Location"
                                    value={
                                        <span className="inline-flex items-center gap-1.5">
                                            <MapPin className="h-3.5 w-3.5 text-[color:var(--color-ink-muted)]" />
                                            {[details.dealer.city, details.dealer.state]
                                                .filter(Boolean)
                                                .join(', ')}
                                        </span>
                                    }
                                />
                            )}
                        </dl>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 py-3">
            <dt className="text-sm text-[color:var(--color-ink-muted)]">{label}</dt>
            <dd className="text-right text-sm font-semibold text-[color:var(--color-brand-navy)]">
                {value}
            </dd>
        </div>
    );
}

function CopyButton({
    active,
    onClick,
    label,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-[color:var(--color-brand-sky)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-sky/60"
        >
            {active ? (
                <Check className="h-3.5 w-3.5 text-[color:var(--color-success)]" />
            ) : (
                <Copy className="h-3.5 w-3.5" />
            )}
        </button>
    );
}
