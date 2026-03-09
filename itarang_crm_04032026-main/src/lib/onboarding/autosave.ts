export async function autosave(data:any){

await fetch("/api/dealer-onboarding/save-draft",{
method:"POST",
headers:{ "Content-Type":"application/json" },
body:JSON.stringify(data)
})

}