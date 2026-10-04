// The CEO's Accounts tab is the same page as Admin's (/admin/accounts, which
// middleware admits the CEO to). Rendered here too so /ceo/accounts works.
import AccountsPage from "../../admin/accounts/page";

export const dynamic = "force-dynamic";

export default AccountsPage;
