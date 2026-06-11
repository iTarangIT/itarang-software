// Route-group loading UI for every page under (dashboard). Rendered by the
// App Router the instant a sidebar link is clicked, so navigation always has
// immediate visual feedback while the (slower) RSC payload streams in. Before
// this existed, a click produced no on-screen change until the page resolved,
// which read as "the link didn't work" and led to repeated clicking.
export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-7 w-56 bg-gray-100 rounded-lg" />
          <div className="h-4 w-72 bg-gray-100 rounded-lg" />
        </div>
        <div className="h-10 w-32 bg-gray-100 rounded-xl" />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-20 bg-gray-100 rounded-xl" />
        ))}
      </div>

      {/* List / table rows */}
      <div className="space-y-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
