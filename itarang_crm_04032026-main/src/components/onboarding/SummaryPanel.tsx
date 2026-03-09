export default function SummaryPanel({form}:any){

return(

<div className="bg-white border p-6 rounded-lg">

<h3 className="font-semibold mb-4">

Application Summary

</h3>

<p>Company: {form.companyName}</p>

<p>Finance Enabled: {form.financeEnabled?"Yes":"No"}</p>

</div>

)

}