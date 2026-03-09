import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { dealerOnboardings } from "@/lib/db/schema"
import { nanoid } from "nanoid"
import { eq } from "drizzle-orm"

export async function POST(req: Request) {

  try {

    const body = await req.json()

    const id = "REG-" + nanoid()

    // Save onboarding data
    await db.insert(dealerOnboardings).values({
      id,
      business_name: body.business_name,
      owner_name: body.owner_name,
      email: body.email,
      phone: body.phone,
      gstin: body.gstin,
      pan: body.pan,
      address: body.address,
      signzy_status: "pending"
    })

    // Temporary agreement link
    const signUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/dealer-agreement/${id}`

    // Update record
    await db.update(dealerOnboardings)
      .set({
        signzy_document_url: signUrl,
        signzy_status: "generated"
      })
      .where(eq(dealerOnboardings.id, id))

    return NextResponse.json({
      success: true,
      onboardingId: id,
      signUrl
    })

  } catch (error) {

    console.error("Dealer onboarding error:", error)

    return NextResponse.json(
      { error: "Dealer onboarding failed" },
      { status: 500 }
    )
  }

}