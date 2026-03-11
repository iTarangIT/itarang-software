"use client"

import {useState,useEffect} from "react"

import Stepper from "@/components/onboarding/Stepper"
import CompanyStep from "@/components/onboarding/steps/CompanyStep"
import ComplianceStep from "@/components/onboarding/steps/ComplianceStep"
import OwnershipStep from "@/components/onboarding/steps/OwnershipStep"
import FinanceStep from "@/components/onboarding/steps/FinanceStep"
import AgreementStep from "@/components/onboarding/steps/AgreementStep"
import ReviewStep from "@/components/onboarding/steps/ReviewStep"

import SummaryPanel from "@/components/onboarding/SummaryPanel"
import {autosaveDraft} from "@/lib/onboarding/autosave"

export default function Page(){

const [step,setStep]=useState(0)

const [form,setForm]=useState({})

useEffect(()=>{

const interval=setInterval(()=>{

autosaveDraft(form)

},4000)

return()=>clearInterval(interval)

},[form])

const steps=[
<CompanyStep form={form} setForm={setForm}/>,
<ComplianceStep form={form} setForm={setForm}/>,
<OwnershipStep form={form} setForm={setForm}/>,
<FinanceStep form={form} setForm={setForm}/>,
<AgreementStep form={form}/>,
<ReviewStep form={form}/>
]

return(

<div className="max-w-7xl mx-auto px-8 py-10">

<Stepper step={step}/>

<div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">

<div className="lg:col-span-2 card">

{steps[step]}

<div className="flex justify-between mt-10">

<button
onClick={()=>setStep(step-1)}
disabled={step===0}
className="border px-4 py-2 rounded"
>

Back

</button>

<button
onClick={()=>setStep(step+1)}
className="button-primary"
>

Next

</button>

</div>

</div>

<SummaryPanel form={form}/>

</div>

</div>

)

}