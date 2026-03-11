"use client"

import UploadCard from "./UploadCard"

export default function ComplianceStep(){

return(

<div className="space-y-6">

<h2 className="text-lg font-semibold">
Financial & Compliance Documents
</h2>

<UploadCard title="Company ITR (3 Years)" onUpload={()=>{}}/>

<UploadCard title="Bank Statement (3 Months)" onUpload={()=>{}}/>

<UploadCard title="Undated Cheques" onUpload={()=>{}}/>

<UploadCard title="Udyam Certificate" onUpload={()=>{}}/>

</div>

)

}