export default function Loading() {
  return (
    <div className="flex-1 overflow-auto bg-gray-50/30">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-start gap-4">
          <div className="h-8 w-20 bg-gray-100 animate-pulse rounded-lg" />
          <div className="space-y-2">
            <div className="h-6 w-72 bg-gray-100 animate-pulse rounded-lg" />
            <div className="h-4 w-48 bg-gray-100 animate-pulse rounded-lg" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 bg-gray-100 animate-pulse rounded-xl"
            />
          ))}
        </div>
        <div className="h-64 bg-gray-100 animate-pulse rounded-xl" />
      </div>
    </div>
  );
}
