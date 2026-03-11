"use client"

export default function Stepper({ step }: { step:number }){

const steps=[
"Company",
"Compliance",
"Ownership",
"Finance",
"Agreement",
"Review"
]

return(

<div className="bg-white border-b border-[#E3E8EF] p-6 flex gap-6">

{steps.map((s,i)=>{

const active=i<=step

return(

<div key={i} className="flex items-center gap-2">

<div className={`w-8 h-8 rounded-full flex items-center justify-center
${active?"bg-[#1F5C8F] text-white":"bg-gray-200"}`}>

{i+1}

</div>

<span className="text-sm">{s}</span>

</div>

)

})}

</div>

)

}