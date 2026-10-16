"use client";

import { useEffect, useState } from "react";

export default function ChangePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // A39: why the user is here — a forced reset or a 90-day-old password.
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(new URLSearchParams(window.location.search).get("expired") === "1");
  }, []);

  const handleSubmit = async () => {
    setError("");

    if (!password || !confirmPassword) {
      setError("Please fill all fields");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    try {
      setLoading(true);

      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ password }),
        headers: {
          "Content-Type": "application/json",
        },
      });

      const result = await res.json();

      if (!res.ok) {
        setError(result.message || "Failed to update password");
        return;
      }

      // Redirect to root — middleware routes to the user's role dashboard
      // (nbfc_partner → /nbfc/portfolio, dealer → /dealer-portal, etc.).
      window.location.href = "/";
    } catch (err) {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
      <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow">
        <h2 className="text-2xl font-bold mb-6 text-center">
          Change Your Password
        </h2>
        <p className="text-sm text-gray-600 mb-4 text-center">
          {expired
            ? "Your password is more than 90 days old. Choose a new one to continue."
            : "Choose a new password to continue. Do not reuse a shared one."}
        </p>

        <input
          type="password"
          placeholder="New Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 px-4 py-3 border rounded-lg"
        />

        <input
          type="password"
          placeholder="Confirm Password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full mb-4 px-4 py-3 border rounded-lg"
        />

        {error && <p className="text-red-500 text-sm mb-3">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={loading}
          className="w-full py-3 bg-[#005596] text-white rounded-lg"
        >
          {loading ? "Updating..." : "Update Password"}
        </button>
      </div>
    </div>
  );
}