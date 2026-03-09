"use client"

import { useState } from "react"

export default function DealerOnboardingPage() {

    const [form, setForm] = useState({
        business_name: "",
        owner_name: "",
        email: "",
        phone: "",
        gstin: "",
        pan: "",
        address: ""
    })

    const [loading, setLoading] = useState(false)

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        setLoading(true)

        try {

            const res = await fetch("/api/dealer-onboarding", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(form)
            })

            if (!res.ok) {
                throw new Error("API failed")
            }

            const data = await res.json()

            if (data.signUrl) {
                window.location.href = data.signUrl
            }

        } catch (error) {
            console.error(error)
            alert("Dealer onboarding failed")
        }

        setLoading(false)
    }

    return (

        <div className="min-h-screen flex items-center justify-center bg-gray-100">

            <div className="bg-white p-8 rounded-lg shadow w-full max-w-xl">

                <h1 className="text-2xl font-bold mb-6 text-center">
                    Dealer Onboarding
                </h1>

                <form onSubmit={handleSubmit} className="space-y-4">

                    <input
                        type="text"
                        placeholder="Business Name"
                        className="border p-2 w-full rounded"
                        required
                        onChange={(e) => setForm({ ...form, business_name: e.target.value })}
                    />

                    <input
                        type="text"
                        placeholder="Owner Name"
                        className="border p-2 w-full rounded"
                        required
                        onChange={(e) => setForm({ ...form, owner_name: e.target.value })}
                    />

                    <input
                        type="email"
                        placeholder="Email"
                        className="border p-2 w-full rounded"
                        required
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                    />

                    <input
                        type="tel"
                        placeholder="Phone"
                        className="border p-2 w-full rounded"
                        required
                        onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    />

                    <input
                        type="text"
                        placeholder="GSTIN"
                        className="border p-2 w-full rounded"
                        required
                        onChange={(e) => setForm({ ...form, gstin: e.target.value })}
                    />

                    <input
                        type="text"
                        placeholder="PAN"
                        className="border p-2 w-full rounded"
                        required
                        onChange={(e) => setForm({ ...form, pan: e.target.value })}
                    />

                    <textarea
                        placeholder="Business Address"
                        className="border p-2 w-full rounded"
                        required
                        onChange={(e) => setForm({ ...form, address: e.target.value })}
                    />

                    <button
                        className="w-full bg-blue-600 text-white p-3 rounded"
                        type="submit"
                        disabled={loading}
                    >
                        {loading ? "Generating Agreement..." : "Generate Agreement"}
                    </button>

                </form>

            </div>

        </div>

    )

}