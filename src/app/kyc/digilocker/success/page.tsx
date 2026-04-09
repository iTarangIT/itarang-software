export default function DigiLockerSuccessPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white rounded-xl shadow-md p-8 max-w-md w-full text-center space-y-4">
        <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900">Consent Received</h1>
        <p className="text-gray-600 text-sm">
          Thank you! Your DigiLocker consent has been recorded successfully.
          Your Aadhaar verification is being processed.
        </p>
        <p className="text-gray-400 text-xs">You can close this window now.</p>
      </div>
    </div>
  );
}
