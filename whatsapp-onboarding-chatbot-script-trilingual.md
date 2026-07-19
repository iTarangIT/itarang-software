# iTarang WhatsApp Onboarding — Chatbot Script (English / Hinglish / Hindi)

This is the conversation script for the iTarang WhatsApp bot. For every step it shows:

- 🤖 **Bot says** — in **English**, **Hinglish** (Roman), and **Hindi** (Devanagari)
- 👤 **User gives** — what the dealer / customer replies with

**Notes**
- `*text*` = WhatsApp **bold** (keep the asterisks; WhatsApp renders them bold). Emojis are part of the message.
- `{...}` = dynamic value filled at runtime (name, company, mobile, etc.).
- Source of truth for the English strings: `src/lib/whatsapp/orchestrator.ts`, `checklist.ts`, `notifications.ts`.
- Two surfaces share the "customer" script: the dealer's **New Lead** console and a customer's **self-onboarding**. Where the ending differs, both are shown.

---

# PART A — SHARED ENTRY (Greeting & Routing)

### A1. First hello / welcome
- 👤 **User gives:** `Hi` (or any first message)
- 🤖 **Bot:**
  - **EN:** `👋 Welcome to *iTarang*! How can I help you today?` <br>`Just type your question or tell me what you'd like to do.`
  - **Hinglish:** `👋 *iTarang* mein aapka swagat hai! Aaj main aapki kya madad kar sakta hoon?` <br>`Bas apna sawaal type karein ya bataayein aap kya karna chahte hain.`
  - **Hindi:** `👋 *iTarang* में आपका स्वागत है! आज मैं आपकी क्या मदद कर सकता हूँ?` <br>`बस अपना सवाल टाइप करें या बताएं आप क्या करना चाहते हैं।`

### A2. Are you a customer or a dealer?
- 👤 **User gives:** taps **Customer** / **Dealer** (or types)
- 🤖 **Bot:**
  - **EN:** `Meanwhile, are you a *customer* or a *dealer*? Tap below 👇`  — buttons: **Customer**, **Dealer**
  - **Hinglish:** `Waise, aap ek *customer* hain ya *dealer*? Neeche tap karein 👇`  — buttons: **Customer**, **Dealer**
  - **Hindi:** `वैसे, क्या आप एक *ग्राहक* हैं या *डीलर*? नीचे टैप करें 👇`  — buttons: **ग्राहक**, **डीलर**

### A3. Chose "Customer"
- 🤖 **Bot:**
  - **EN:** `👍 Great! You're here to *purchase a battery / charger*. For that we'll need a few details from you — please share the following 👇`
  - **Hinglish:** `👍 Badhiya! Aap *battery / charger kharidne* ke liye aaye hain. Iske liye humein aapse kuch details chahiye — kripya neeche di gayi jaankari share karein 👇`
  - **Hindi:** `👍 बढ़िया! आप *बैटरी / चार्जर खरीदने* के लिए आए हैं। इसके लिए हमें आपसे कुछ जानकारी चाहिए — कृपया नीचे दी गई जानकारी साझा करें 👇`

### A4. Chose "Dealer"
- 🤖 **Bot:**
  - **EN:** `👍 Great! To become an *iTarang dealer*, we'll need some information from you, as follows 👇`
  - **Hinglish:** `👍 Badhiya! *iTarang dealer* banne ke liye humein aapse kuch jaankari chahiye, jo is prakaar hai 👇`
  - **Hindi:** `👍 बढ़िया! *iTarang डीलर* बनने के लिए हमें आपसे कुछ जानकारी चाहिए, जो इस प्रकार है 👇`

### A5. Stop / exit
- 👤 **User gives:** `stop` / `end` / `exit`
- 🤖 **Bot:**
  - **EN:** `👋 Okay, I've ended that for now. Send *hi* anytime to start again.`
  - **Hinglish:** `👋 Theek hai, maine ise abhi ke liye band kar diya hai. Dobara shuru karne ke liye kabhi bhi *hi* bhejein.`
  - **Hindi:** `👋 ठीक है, मैंने इसे अभी के लिए बंद कर दिया है। दोबारा शुरू करने के लिए कभी भी *hi* भेजें।`

### A6. Something went wrong (generic error)
- 🤖 **Bot:**
  - **EN:** `Sorry, something went wrong on our side. Please try again in a moment.`
  - **Hinglish:** `Maaf kijiye, humaari taraf se kuch gadbad ho gayi. Kripya thodi der baad dobara koshish karein.`
  - **Hindi:** `माफ़ कीजिए, हमारी तरफ़ से कुछ गड़बड़ हो गई। कृपया थोड़ी देर बाद दोबारा कोशिश करें।`

### A7. Resume a dealer application in progress
- 🤖 **Bot:**
  - **EN:** `Hi *{name}* 👋 You have a dealer application in progress.` <br>`Continue where you left off, or start fresh?` — buttons: **Resume**, **Start Over**
  - **Hinglish:** `Hi *{name}* 👋 Aapki ek dealer application chal rahi hai.` <br>`Jahaan chhoda tha wahaan se aage badhein, ya naye sire se shuru karein?` — buttons: **Resume**, **Start Over**
  - **Hindi:** `नमस्ते *{name}* 👋 आपकी एक डीलर एप्लिकेशन चल रही है।` <br>`जहाँ छोड़ा था वहाँ से आगे बढ़ें, या नए सिरे से शुरू करें?` — buttons: **जारी रखें**, **फिर से शुरू करें**

---

# PART B — DEALER ONBOARDING SCRIPT

### B1. Company type
- 👤 **User gives:** taps **Sole Proprietor / Partnership / Private Limited**
- 🤖 **Bot:**
  - **EN:** `What is your *company type*? Tap an option below 👇` — buttons: **Sole Proprietor**, **Partnership**, **Private Limited**
  - **Hinglish:** `Aapki *company ka type* kya hai? Neeche ek option tap karein 👇` — buttons: **Sole Proprietor**, **Partnership**, **Private Limited**
  - **Hindi:** `आपकी *कंपनी का प्रकार* क्या है? नीचे एक विकल्प टैप करें 👇` — buttons: **एकल स्वामित्व (Sole Proprietor)**, **साझेदारी (Partnership)**, **प्राइवेट लिमिटेड**

### B2. Didn't understand the company type
- 🤖 **Bot:**
  - **EN:** `Sorry, I didn't catch that.`
  - **Hinglish:** `Maaf kijiye, main samajh nahi paaya.`
  - **Hindi:** `माफ़ कीजिए, मैं समझ नहीं पाया।`

### B3. Document checklist
- 🤖 **Bot:**
  - **EN:** `Great — *{companyType}*.` <br>`📋 Here are the documents I'll need for your onboarding:` <br>`1. GST Certificate` <br>`2. Company PAN` <br>`... (list continues by company type)`
  - **Hinglish:** `Badhiya — *{companyType}*.` <br>`📋 Aapke onboarding ke liye mujhe ye documents chahiye honge:` <br>`1. GST Certificate` <br>`2. Company PAN` <br>`... (company type ke hisaab se list aage badhti hai)`
  - **Hindi:** `बढ़िया — *{companyType}*.` <br>`📋 आपके ऑनबोर्डिंग के लिए मुझे ये दस्तावेज़ चाहिए होंगे:` <br>`1. GST प्रमाणपत्र` <br>`2. कंपनी PAN` <br>`... (कंपनी प्रकार के अनुसार सूची आगे बढ़ती है)`

### B4. How to send documents
- 👤 **User gives:** taps **Upload all (ZIP)** / **Send one by one**
- 🤖 **Bot:**
  - **EN:** `How would you like to send them? You can put *all documents in one folder (ZIP)* and upload together, or send them *one at a time*. 👇` — buttons: **Upload all (ZIP)**, **Send one by one**
  - **Hinglish:** `Aap inhe kaise bhejna chahenge? Aap *sabhi documents ek folder (ZIP) mein* daal kar ek saath upload kar sakte hain, ya *ek-ek karke* bhej sakte hain. 👇` — buttons: **Upload all (ZIP)**, **Send one by one**
  - **Hindi:** `आप इन्हें कैसे भेजना चाहेंगे? आप *सभी दस्तावेज़ एक फ़ोल्डर (ZIP) में* डालकर एक साथ अपलोड कर सकते हैं, या *एक-एक करके* भेज सकते हैं। 👇` — buttons: **सभी अपलोड करें (ZIP)**, **एक-एक करके भेजें**

### B5. Chose ZIP
- 👤 **User gives:** attaches a `.zip`
- 🤖 **Bot:**
  - **EN:** `📦 Great — please attach a *single .zip file* containing all the documents from the list above. I'll read them all and tell you if anything is missing or unclear.`
  - **Hinglish:** `📦 Badhiya — kripya upar di gayi list ke sabhi documents wali *ek .zip file* attach karein. Main sabhi ko padh loonga aur bataunga agar kuch missing ya unclear hai.`
  - **Hindi:** `📦 बढ़िया — कृपया ऊपर दी गई सूची के सभी दस्तावेज़ों वाली *एक .zip फ़ाइल* अटैच करें। मैं सभी को पढ़ लूँगा और बताऊँगा अगर कुछ गायब या अस्पष्ट है।`

### B6. Chose one-by-one
- 👤 **User gives:** sends first document
- 🤖 **Bot:**
  - **EN:** `📄 No problem — let's go one by one.` <br>`{first document request}`
  - **Hinglish:** `📄 Koi baat nahi — chaliye ek-ek karke karte hain.` <br>`{pehle document ki request}`
  - **Hindi:** `📄 कोई बात नहीं — चलिए एक-एक करके करते हैं।` <br>`{पहले दस्तावेज़ का अनुरोध}`

### B7. Document request messages (sent one at a time)
| Document | 🤖 EN | 🤖 Hinglish | 🤖 Hindi |
|---|---|---|---|
| GST Certificate | `Please send your *GST Certificate* (photo or PDF).` | `Kripya apna *GST Certificate* bhejein (photo ya PDF).` | `कृपया अपना *GST प्रमाणपत्र* भेजें (फ़ोटो या PDF)।` |
| Company PAN | `Please send your *Company PAN card*.` | `Kripya apna *Company PAN card* bhejein.` | `कृपया अपना *कंपनी PAN कार्ड* भेजें।` |
| Bank statement | `Please send your *last 3 months' company bank statement*.` | `Kripya apni *pichhle 3 mahine ki company bank statement* bhejein.` | `कृपया अपनी *पिछले 3 महीने की कंपनी बैंक स्टेटमेंट* भेजें।` |
| Cancelled cheque | `Please send a *cancelled cheque* of your company account.` | `Kripya apne company account ka *cancelled cheque* bhejein.` | `कृपया अपने कंपनी खाते का *कैंसल्ड चेक* भेजें।` |
| Udyam | `Please send your *Udyam Registration Certificate*.` | `Kripya apna *Udyam Registration Certificate* bhejein.` | `कृपया अपना *उद्यम पंजीकरण प्रमाणपत्र* भेजें।` |
| Owner photo | `Please send a *passport-size photograph* of the owner.` | `Kripya owner ki *passport-size photo* bhejein.` | `कृपया मालिक की *पासपोर्ट-साइज़ फ़ोटो* भेजें।` |
| Owner Aadhaar | `Please send the *owner's Aadhaar card* (the side showing the 12-digit Aadhaar number).` | `Kripya *owner ka Aadhaar card* bhejein (jis taraf 12-digit Aadhaar number hai).` | `कृपया *मालिक का आधार कार्ड* भेजें (जिस तरफ़ 12-अंकों का आधार नंबर है)।` |
| ITR | `Please send your *last 3 years' Income Tax Returns (ITR)* (a single PDF is fine).` | `Kripya apna *pichhle 3 saal ka Income Tax Return (ITR)* bhejein (ek hi PDF chalega).` | `कृपया अपना *पिछले 3 वर्षों का आयकर रिटर्न (ITR)* भेजें (एक ही PDF ठीक है)।` |
| Partnership deed | `Please send a *copy of your Partnership Deed*.` | `Kripya apni *Partnership Deed ki copy* bhejein.` | `कृपया अपनी *साझेदारी विलेख (Partnership Deed) की प्रति* भेजें।` |
| Partner photo | `Please send a *passport-size photograph of the partner(s)*.` | `Kripya *partner(s) ki passport-size photo* bhejein.` | `कृपया *साझेदार(ों) की पासपोर्ट-साइज़ फ़ोटो* भेजें।` |
| MoA | `Please send your *Memorandum of Association (MoA)*.` | `Kripya apna *Memorandum of Association (MoA)* bhejein.` | `कृपया अपना *मेमोरेंडम ऑफ़ एसोसिएशन (MoA)* भेजें।` |
| AoA | `Please send your *Articles of Association (AoA)*.` | `Kripya apna *Articles of Association (AoA)* bhejein.` | `कृपया अपना *आर्टिकल्स ऑफ़ एसोसिएशन (AoA)* भेजें।` |
| Director photo | `Please send a *passport-size photograph of the partner(s)/director(s)*.` | `Kripya *partner(s)/director(s) ki passport-size photo* bhejein.` | `कृपया *साझेदार(ों)/निदेशक(ों) की पासपोर्ट-साइज़ फ़ोटो* भेजें।` |
| LLP Agreement | `Please send your *LLP Agreement*.` | `Kripya apna *LLP Agreement* bhejein.` | `कृपया अपना *LLP एग्रीमेंट* भेजें।` |

### B8. Sent text instead of a file
- 👤 **User gives:** a document (photo/PDF)
- 🤖 **Bot:**
  - **EN:** `Please send a *photo or PDF*. {request}`
  - **Hinglish:** `Kripya ek *photo ya PDF* bhejein. {request}`
  - **Hindi:** `कृपया एक *फ़ोटो या PDF* भेजें। {request}`

### B9. Couldn't read the document clearly
- 👤 **User gives:** a clearer copy, or `skip`
- 🤖 **Bot:**
  - **EN:** `I couldn't read that clearly. {request}` <br>`_If you don't have a clearer copy, reply *skip*._`
  - **Hinglish:** `Main ise saaf padh nahi paaya. {request}` <br>`_Agar aapke paas saaf copy nahi hai, to *skip* likhein._`
  - **Hindi:** `मैं इसे साफ़ नहीं पढ़ पाया। {request}` <br>`_अगर आपके पास साफ़ प्रति नहीं है, तो *skip* लिखें।_`

### B10. Wrong / not-required document
- 🤖 **Bot:**
  - **EN:** `⚠️ That looks like a *{docType}*, which isn't a required document for a *{companyType}*, so I won't store it.`
  - **Hinglish:** `⚠️ Ye ek *{docType}* lag raha hai, jo *{companyType}* ke liye zaroori document nahi hai, isliye main ise store nahi karunga.`
  - **Hindi:** `⚠️ यह एक *{docType}* लग रहा है, जो *{companyType}* के लिए आवश्यक दस्तावेज़ नहीं है, इसलिए मैं इसे संग्रहीत नहीं करूँगा।`

### B11. Document accepted
- 🤖 **Bot:**
  - **EN:** `Got your *{label}* ✅` (if unclear: ` (some values were hard to read — our team will double-check)`)
  - **Hinglish:** `Aapka *{label}* mil gaya ✅` (agar unclear: ` (kuch values padhne mein mushkil thi — humaari team dobara check karegi)`)
  - **Hindi:** `आपका *{label}* मिल गया ✅` (अगर अस्पष्ट: ` (कुछ जानकारी पढ़ना मुश्किल था — हमारी टीम दोबारा जाँच करेगी)`)

### B12. Skipped a document
- 🤖 **Bot:**
  - **EN:** `No problem — we'll continue without the *{label}* for now. 👍` <br>`Whenever you have it, just send it here on WhatsApp and our team will add it to your application.`
  - **Hinglish:** `Koi baat nahi — abhi ke liye hum *{label}* ke bina aage badhte hain. 👍` <br>`Jab bhi aapke paas ho, use yahaan WhatsApp par bhej dein aur humaari team use aapki application mein jod degi.`
  - **Hindi:** `कोई बात नहीं — अभी के लिए हम *{label}* के बिना आगे बढ़ते हैं। 👍` <br>`जब भी आपके पास हो, उसे यहाँ WhatsApp पर भेज दें और हमारी टीम उसे आपकी एप्लिकेशन में जोड़ देगी।`

### B13. All documents received
- 🤖 **Bot:**
  - **EN:** `Thank you! I've received all your documents. ✅`
  - **Hinglish:** `Dhanyavaad! Mujhe aapke sabhi documents mil gaye hain. ✅`
  - **Hindi:** `धन्यवाद! मुझे आपके सभी दस्तावेज़ मिल गए हैं। ✅`

### B14. Still-needed list (before submit)
- 👤 **User gives:** sends the missing docs, or `skip`
- 🤖 **Bot:**
  - **EN:** `Before I can submit, I still need a few things:` <br>`• *{label}* — not received yet` <br>`• *{label}* — couldn't read the {fields}; please resend a clearer copy` <br>`{request}` <br>`_If you don't have it, just reply *skip* and our team will follow up._`
  - **Hinglish:** `Submit karne se pehle mujhe abhi kuch cheezein chahiye:` <br>`• *{label}* — abhi tak nahi mila` <br>`• *{label}* — {fields} padh nahi paaya; kripya saaf copy dobara bhejein` <br>`{request}` <br>`_Agar aapke paas nahi hai, to *skip* likhein aur humaari team follow up karegi._`
  - **Hindi:** `सबमिट करने से पहले मुझे अभी कुछ चीज़ें चाहिए:` <br>`• *{label}* — अभी तक नहीं मिला` <br>`• *{label}* — {fields} पढ़ नहीं पाया; कृपया साफ़ प्रति दोबारा भेजें` <br>`{request}` <br>`_अगर आपके पास नहीं है, तो *skip* लिखें और हमारी टीम फ़ॉलो-अप करेगी।_`

### B15. Financing question
- 👤 **User gives:** taps **Yes** / **No**
- 🤖 **Bot:**
  - **EN:** `Do you want *financing enabled* for your customers? Tap an option below 👇` — buttons: **Yes**, **No**
  - **Hinglish:** `Kya aap apne customers ke liye *financing enable* karna chahte hain? Neeche ek option tap karein 👇` — buttons: **Yes**, **No**
  - **Hindi:** `क्या आप अपने ग्राहकों के लिए *फ़ाइनेंसिंग चालू* करना चाहते हैं? नीचे एक विकल्प टैप करें 👇` — buttons: **हाँ**, **नहीं**

### B16. Confirm signer (owner)
- 👤 **User gives:** taps **Correct** / **Change**
- 🤖 **Bot:**
  - **EN:** `Please confirm the *signer (owner)* for your dealer agreement:` <br>`*Name:* {ownerName}` <br>`*Email:* {ownerEmail}` <br>`*Phone:* {ownerPhone}` <br>`Tap *Correct* to submit, or *Change* to edit these.` — buttons: **Correct**, **Change**
  - **Hinglish:** `Kripya apne dealer agreement ke *signer (owner)* ki pushti karein:` <br>`*Name:* {ownerName}` <br>`*Email:* {ownerEmail}` <br>`*Phone:* {ownerPhone}` <br>`Submit karne ke liye *Correct* tap karein, ya edit karne ke liye *Change*.` — buttons: **Correct**, **Change**
  - **Hindi:** `कृपया अपने डीलर एग्रीमेंट के *हस्ताक्षरकर्ता (मालिक)* की पुष्टि करें:` <br>`*नाम:* {ownerName}` <br>`*ईमेल:* {ownerEmail}` <br>`*फ़ोन:* {ownerPhone}` <br>`सबमिट करने के लिए *सही है* टैप करें, या बदलने के लिए *बदलें*।` — buttons: **सही है**, **बदलें**

### B17. Which detail to change
- 👤 **User gives:** taps **Name** / **Email** / **Phone**
- 🤖 **Bot:**
  - **EN:** `No problem — which detail would you like to change?` — buttons: **Name**, **Email**, **Phone**
  - **Hinglish:** `Koi baat nahi — aap kaun si detail badalna chahte hain?` — buttons: **Name**, **Email**, **Phone**
  - **Hindi:** `कोई बात नहीं — आप कौन सी जानकारी बदलना चाहते हैं?` — buttons: **नाम**, **ईमेल**, **फ़ोन**

### B18. Change-path questions (typed)
| Field | 🤖 EN | 🤖 Hinglish | 🤖 Hindi |
|---|---|---|---|
| Owner name | `What is the *owner's full name*?` | `*Owner ka pura naam* kya hai?` | `*मालिक का पूरा नाम* क्या है?` |
| Owner mobile | `What is the *owner's mobile number*?` | `*Owner ka mobile number* kya hai?` | `*मालिक का मोबाइल नंबर* क्या है?` |
| Owner email | `What is the *owner's email address*?` | `*Owner ka email address* kya hai?` | `*मालिक का ईमेल पता* क्या है?` |

### B19. Summary before submit
- 👤 **User gives:** taps **Confirm** / **Change**
- 🤖 **Bot:**
  - **EN:** `Please confirm your dealer onboarding details:` <br>`*Company:* … *Company type:* … *GST:* … *PAN:* … *Bank:* … *Account:* … *IFSC:* … *Owner:* … *Mobile:* … *Email:* … *Financing:* Yes/No *Documents received:* …` <br>`Reply *CONFIRM* to submit, or *CHANGE* if anything is wrong.` — buttons: **Confirm**, **Change**
  - **Hinglish:** `Kripya apni dealer onboarding details ki pushti karein:` <br>`*Company:* … *Company type:* … *GST:* … *PAN:* … *Bank:* … *Account:* … *IFSC:* … *Owner:* … *Mobile:* … *Email:* … *Financing:* Yes/No *Documents received:* …` <br>`Submit karne ke liye *CONFIRM* bhejein, ya kuch galat hai to *CHANGE*.` — buttons: **Confirm**, **Change**
  - **Hindi:** `कृपया अपनी डीलर ऑनबोर्डिंग जानकारी की पुष्टि करें:` <br>`*कंपनी:* … *कंपनी प्रकार:* … *GST:* … *PAN:* … *बैंक:* … *खाता:* … *IFSC:* … *मालिक:* … *मोबाइल:* … *ईमेल:* … *फ़ाइनेंसिंग:* हाँ/नहीं *प्राप्त दस्तावेज़:* …` <br>`सबमिट करने के लिए *CONFIRM* भेजें, या कुछ ग़लत हो तो *CHANGE*।` — buttons: **पुष्टि करें**, **बदलें**

### B20. Submitted ✅ (terminal)
- 🤖 **Bot:**
  - **EN:** `✅ *Submitted!* Thank you. Our team will review your application and get back to you on WhatsApp shortly.`
  - **Hinglish:** `✅ *Submit ho gaya!* Dhanyavaad. Humaari team aapki application review karke jaldi hi aapse WhatsApp par sampark karegi.`
  - **Hindi:** `✅ *सबमिट हो गया!* धन्यवाद। हमारी टीम आपकी एप्लिकेशन की समीक्षा करके जल्द ही आपसे WhatsApp पर संपर्क करेगी।`

### B21. Correction requested by reviewer
- 👤 **User gives:** starts fixing items
- 🤖 **Bot:**
  - **EN:** `🔔 *Our team needs a few corrections* before we can approve your application.` <br>`*What the reviewer noted:* {remarks}` <br>`Please fix these {n} item(s):` <br>`{item list}` <br>`Let's start 👇`
  - **Hinglish:** `🔔 *Aapki application approve karne se pehle humaari team ko kuch corrections chahiye.*` <br>`*Reviewer ne ye note kiya:* {remarks}` <br>`Kripya ye {n} cheezein theek karein:` <br>`{item list}` <br>`Chaliye shuru karte hain 👇`
  - **Hindi:** `🔔 *आपकी एप्लिकेशन स्वीकृत करने से पहले हमारी टीम को कुछ सुधार चाहिए।*` <br>`*समीक्षक ने यह नोट किया:* {remarks}` <br>`कृपया ये {n} चीज़ें ठीक करें:` <br>`{item list}` <br>`चलिए शुरू करते हैं 👇`

### B22. Correction — field / document prompts
| Type | 🤖 EN | 🤖 Hinglish | 🤖 Hindi |
|---|---|---|---|
| Field | `✏️ Please send the corrected *{fieldLabel}*.` | `✏️ Kripya sahi kiya hua *{fieldLabel}* bhejein.` | `✏️ कृपया सही किया हुआ *{fieldLabel}* भेजें।` |
| Document | `📄 Please re-upload your *{documentLabel}* as a photo or PDF.` | `📄 Kripya apna *{documentLabel}* photo ya PDF ke roop mein dobara upload karein.` | `📄 कृपया अपना *{documentLabel}* फ़ोटो या PDF के रूप में दोबारा अपलोड करें।` |

### B23. Corrections submitted (terminal)
- 🤖 **Bot:**
  - **EN:** `✅ *Thank you!* Your corrections have been submitted. Our team will review them and get back to you on WhatsApp shortly.`
  - **Hinglish:** `✅ *Dhanyavaad!* Aapke corrections submit ho gaye hain. Humaari team inhe review karke jaldi hi aapse WhatsApp par sampark karegi.`
  - **Hindi:** `✅ *धन्यवाद!* आपके सुधार सबमिट हो गए हैं। हमारी टीम इनकी समीक्षा करके जल्द ही आपसे WhatsApp पर संपर्क करेगी।`

### B24. Approved — login credentials sent (push)
- 🤖 **Bot:**
  - **EN:** `🎉 *Welcome to iTarang, {dealerName}!*` <br>`Your dealer account for *{companyName}* is now *active*. Here are your login details:` <br>`🔗 *Portal:* {loginUrl}` <br>`🆔 *Login ID:* {loginId}` <br>`🔑 *Temporary Password:* {password}` <br>`🏷️ *Dealer ID:* {dealerCode}` <br>`⚠️ Please log in and *change your password* on first use.`
  - **Hinglish:** `🎉 *iTarang mein aapka swagat hai, {dealerName}!*` <br>`*{companyName}* ke liye aapka dealer account ab *active* hai. Ye rahi aapki login details:` <br>`🔗 *Portal:* {loginUrl}` <br>`🆔 *Login ID:* {loginId}` <br>`🔑 *Temporary Password:* {password}` <br>`🏷️ *Dealer ID:* {dealerCode}` <br>`⚠️ Kripya login karein aur pehli baar mein hi *apna password badal lein*.`
  - **Hindi:** `🎉 *iTarang में आपका स्वागत है, {dealerName}!*` <br>`*{companyName}* के लिए आपका डीलर खाता अब *सक्रिय* है। ये रही आपकी लॉगिन जानकारी:` <br>`🔗 *पोर्टल:* {loginUrl}` <br>`🆔 *लॉगिन ID:* {loginId}` <br>`🔑 *अस्थायी पासवर्ड:* {password}` <br>`🏷️ *डीलर ID:* {dealerCode}` <br>`⚠️ कृपया लॉगिन करें और पहली बार में ही *अपना पासवर्ड बदल लें*।`

### B25. Rejected (push)
- 🤖 **Bot:**
  - **EN:** `Hi {dealerName}, we've reviewed your iTarang dealer application for *{companyName}* and unfortunately it was *not approved* at this time.` <br>`*Reason:* {remarks}`
  - **Hinglish:** `Hi {dealerName}, humne *{companyName}* ke liye aapki iTarang dealer application review ki hai aur durbhagyavash ise abhi *approve nahi kiya gaya*.` <br>`*Kaaran:* {remarks}`
  - **Hindi:** `नमस्ते {dealerName}, हमने *{companyName}* के लिए आपकी iTarang डीलर एप्लिकेशन की समीक्षा की है और दुर्भाग्यवश इसे अभी *स्वीकृत नहीं किया गया*।` <br>`*कारण:* {remarks}`

---

# PART C — CUSTOMER / NEW-LEAD ONBOARDING SCRIPT

> Used by the dealer's **New Lead** console and a customer's **self-onboarding**. Endings differ ("dealer portal" vs "our team will contact you") — both shown where relevant.

### C0. Dealer console menu (dealer path only)
- 👤 **User gives:** taps a menu row
- 🤖 **Bot:**
  - **EN:** `👋 Hi *{dealerName}*!` <br>`What would you like to do?` — rows: **🆕 New Lead**, **📝 Save Drafts**, **📦 Inventory**, **❓ Help**
  - **Hinglish:** `👋 Hi *{dealerName}*!` <br>`Aap kya karna chahenge?` — rows: **🆕 New Lead**, **📝 Save Drafts**, **📦 Inventory**, **❓ Help**
  - **Hindi:** `👋 नमस्ते *{dealerName}*!` <br>`आप क्या करना चाहेंगे?` — rows: **🆕 नया लीड**, **📝 ड्राफ़्ट सहेजें**, **📦 इन्वेंटरी**, **❓ सहायता**

### C1. New Lead — customer's mobile
- 👤 **User gives:** 10-digit mobile number
- 🤖 **Bot:**
  - **EN:** `🆕 *New Lead*` <br>`Please enter the *customer's mobile number* (10 digits).`
  - **Hinglish:** `🆕 *New Lead*` <br>`Kripya *customer ka mobile number* enter karein (10 digit).`
  - **Hindi:** `🆕 *नया लीड*` <br>`कृपया *ग्राहक का मोबाइल नंबर* दर्ज करें (10 अंक)।`

### C2. Invalid mobile
- 🤖 **Bot:**
  - **EN:** `That doesn't look right. Please enter the customer's *10-digit mobile number*.`
  - **Hinglish:** `Ye sahi nahi lag raha. Kripya customer ka *10-digit mobile number* enter karein.`
  - **Hindi:** `यह सही नहीं लग रहा। कृपया ग्राहक का *10-अंकों का मोबाइल नंबर* दर्ज करें।`

### C3. Interest level (dealer path only)
- 👤 **User gives:** taps **Hot / Warm / Cold**
- 🤖 **Bot:**
  - **EN:** `Got it ✅` <br>`*Lead Classification*` <br>`_Lead interest level_` <br>`Tap the customer's interest level 👇` — buttons: **🔥 Hot**, **🌤 Warm**, **❄ Cold**
  - **Hinglish:** `Samajh gaya ✅` <br>`*Lead Classification*` <br>`_Lead interest level_` <br>`Customer ka interest level tap karein 👇` — buttons: **🔥 Hot**, **🌤 Warm**, **❄ Cold**
  - **Hindi:** `समझ गया ✅` <br>`*लीड वर्गीकरण*` <br>`_लीड रुचि स्तर_` <br>`ग्राहक का रुचि स्तर टैप करें 👇` — buttons: **🔥 गर्म (Hot)**, **🌤 सामान्य (Warm)**, **❄ ठंडा (Cold)**

### C4. Payment method
- 👤 **User gives:** taps **iTarang Finance / Cash / Other Finance**
- 🤖 **Bot:**
  - **EN:** `*Payment method*` <br>`How will the customer pay? Tap an option 👇` — buttons: **iTarang Finance**, **Cash**, **Other Finance**
  - **Hinglish:** `*Payment method*` <br>`Customer kaise payment karega? Ek option tap karein 👇` — buttons: **iTarang Finance**, **Cash**, **Other Finance**
  - **Hindi:** `*भुगतान का तरीका*` <br>`ग्राहक कैसे भुगतान करेगा? एक विकल्प टैप करें 👇` — buttons: **iTarang फ़ाइनेंस**, **नकद (Cash)**, **अन्य फ़ाइनेंस**

### C5. Product selection
- 👤 **User gives:** taps a product
- 🤖 **Bot:**
  - **EN:** `*Product details*` <br>`Which product is this lead for? Tap one 👇` — list: product name / `{assetType} · {n} in stock`
  - **Hinglish:** `*Product details*` <br>`Ye lead kis product ke liye hai? Ek chunein 👇` — list: product name / `{assetType} · {n} in stock`
  - **Hindi:** `*उत्पाद विवरण*` <br>`यह लीड किस उत्पाद के लिए है? एक चुनें 👇` — list: उत्पाद नाम / `{assetType} · {n} स्टॉक में`

### C6a. Cash → vehicle registration number
- 👤 **User gives:** vehicle reg. no. (e.g. HR 35 A 7898)
- 🤖 **Bot:**
  - **EN:** `🚗 What's the *vehicle registration number*? (e.g. HR 35 A 7898)`
  - **Hinglish:** `🚗 *Vehicle registration number* kya hai? (jaise HR 35 A 7898)`
  - **Hindi:** `🚗 *वाहन पंजीकरण नंबर* क्या है? (जैसे HR 35 A 7898)`

### C6b. Hot finance → collect KYC docs then consent
- 🤖 **Bot:**
  - **EN:** `✅ *Product saved.*` <br>`This is a *Hot* finance lead, so we'll need the customer's *KYC documents* and then their *consent*.` <br>`Let's start with the documents 👇`
  - **Hinglish:** `✅ *Product save ho gaya.*` <br>`Ye ek *Hot* finance lead hai, isliye humein customer ke *KYC documents* aur phir unki *consent* chahiye hogi.` <br>`Chaliye documents se shuru karte hain 👇`
  - **Hindi:** `✅ *उत्पाद सहेजा गया।*` <br>`यह एक *Hot* फ़ाइनेंस लीड है, इसलिए हमें ग्राहक के *KYC दस्तावेज़* और फिर उनकी *सहमति* चाहिए होगी।` <br>`चलिए दस्तावेज़ों से शुरू करते हैं 👇`

### C6c. Warm / Cold finance — lead saved (terminal)
- 🤖 **Bot (customer flow):**
  - **EN:** `✅ *Thanks — we've saved your request!*` <br>`Mobile: … Interest: … Payment: …` <br>`Our team will contact you shortly.`
  - **Hinglish:** `✅ *Dhanyavaad — humne aapka request save kar liya hai!*` <br>`Mobile: … Interest: … Payment: …` <br>`Humaari team jaldi hi aapse sampark karegi.`
  - **Hindi:** `✅ *धन्यवाद — हमने आपका अनुरोध सहेज लिया है!*` <br>`मोबाइल: … रुचि: … भुगतान: …` <br>`हमारी टीम जल्द ही आपसे संपर्क करेगी।`
- 🤖 **Bot (dealer flow):**
  - **EN:** `✅ *Lead saved!*` <br>`Mobile: … Interest: … Payment: …` <br>`You can complete the rest on the dealer portal. Send *menu* for more.`
  - **Hinglish:** `✅ *Lead save ho gaya!*` <br>`Mobile: … Interest: … Payment: …` <br>`Baaki aap dealer portal par pura kar sakte hain. Aur ke liye *menu* bhejein.`
  - **Hindi:** `✅ *लीड सहेजा गया!*` <br>`मोबाइल: … रुचि: … भुगतान: …` <br>`बाक़ी आप डीलर पोर्टल पर पूरा कर सकते हैं। और के लिए *menu* भेजें।`

### C7. Cash flow — request Aadhaar + PAN
- 👤 **User gives:** sends Aadhaar (front & back) and PAN, one at a time
- 🤖 **Bot:**
  - **EN:** `📎 Now send the customer's *Aadhaar (front & back)* and *PAN card* (photos or PDF, one at a time). All three are required; I'll read the name, date of birth and address from them.`
  - **Hinglish:** `📎 Ab customer ka *Aadhaar (front & back)* aur *PAN card* bhejein (photo ya PDF, ek-ek karke). Teeno zaroori hain; main inse name, date of birth aur address padh loonga.`
  - **Hindi:** `📎 अब ग्राहक का *आधार (आगे और पीछे)* और *PAN कार्ड* भेजें (फ़ोटो या PDF, एक-एक करके)। तीनों आवश्यक हैं; मैं इनसे नाम, जन्म तिथि और पता पढ़ लूँगा।`

### C8. Document accepted (progress)
- 🤖 **Bot:**
  - **EN:** `Got *{docLabel}* ✅` (customer KYC: `Got *{docLabel}* ✅ ({have}/5)`)
  - **Hinglish:** `*{docLabel}* mil gaya ✅` (customer KYC: `*{docLabel}* mil gaya ✅ ({have}/5)`)
  - **Hindi:** `*{docLabel}* मिल गया ✅` (customer KYC: `*{docLabel}* मिल गया ✅ ({have}/5)`)

### C9. Still needed
- 🤖 **Bot:**
  - **EN:** `Still needed:` <br>`• {docLabel}`
  - **Hinglish:** `Abhi bhi chahiye:` <br>`• {docLabel}`
  - **Hindi:** `अभी भी चाहिए:` <br>`• {docLabel}`

### C10. Document doesn't match the customer
- 👤 **User gives:** resends the correct person's document
- 🤖 **Bot:**
  - **EN:** `⚠️ This document doesn't match the customer.` <br>`*Customer name:* {established}` <br>`*{docLabel} name:* {docName}` <br>`Please check and send the *{docLabel}* that belongs to *{established}*.`
  - **Hinglish:** `⚠️ Ye document customer se match nahi karta.` <br>`*Customer name:* {established}` <br>`*{docLabel} name:* {docName}` <br>`Kripya check karke *{established}* ka *{docLabel}* bhejein.`
  - **Hindi:** `⚠️ यह दस्तावेज़ ग्राहक से मेल नहीं खाता।` <br>`*ग्राहक का नाम:* {established}` <br>`*{docLabel} का नाम:* {docName}` <br>`कृपया जाँच कर *{established}* का *{docLabel}* भेजें।`

### C11. Customer KYC checklist (hot finance)
- 👤 **User gives:** sends documents; types `done` when finished
- 🤖 **Bot:**
  - **EN:** `📎 *Customer documents needed*` <br>`Please send these (one by one, or all together — photos, PDFs, or a ZIP):` <br>`*Required:*` <br>`1️⃣ Aadhaar — *front*` <br>`2️⃣ Aadhaar — *back*` <br>`3️⃣ PAN card` <br>`4️⃣ *RC copy* (vehicle Registration Certificate)` <br>`5️⃣ Passport-size *photo*` <br>`*Optional* (send if you have them):` <br>`▫️ *Bank cheque* (cancelled cheque) or *passbook photo*` <br>`Type *done* when you've sent everything.`
  - **Hinglish:** `📎 *Customer ke documents chahiye*` <br>`Kripya ye bhejein (ek-ek karke, ya sabhi ek saath — photo, PDF, ya ZIP):` <br>`*Zaroori:*` <br>`1️⃣ Aadhaar — *front*` <br>`2️⃣ Aadhaar — *back*` <br>`3️⃣ PAN card` <br>`4️⃣ *RC copy* (vehicle Registration Certificate)` <br>`5️⃣ Passport-size *photo*` <br>`*Optional* (agar ho to bhejein):` <br>`▫️ *Bank cheque* (cancelled cheque) ya *passbook photo*` <br>`Sab bhej dene ke baad *done* type karein.`
  - **Hindi:** `📎 *ग्राहक के दस्तावेज़ चाहिए*` <br>`कृपया ये भेजें (एक-एक करके, या सभी एक साथ — फ़ोटो, PDF, या ZIP):` <br>`*आवश्यक:*` <br>`1️⃣ आधार — *आगे*` <br>`2️⃣ आधार — *पीछे*` <br>`3️⃣ PAN कार्ड` <br>`4️⃣ *RC कॉपी* (वाहन पंजीकरण प्रमाणपत्र)` <br>`5️⃣ पासपोर्ट-साइज़ *फ़ोटो*` <br>`*वैकल्पिक* (अगर हो तो भेजें):` <br>`▫️ *बैंक चेक* (कैंसल्ड चेक) या *पासबुक फ़ोटो*` <br>`सब भेजने के बाद *done* टाइप करें।`

### C12. Duplicate lead
- 🤖 **Bot:**
  - **EN:** `⚠️ This customer already has a lead in process with iTarang (*{ref}*).` <br>`These documents are already linked to that lead, so you can't create a new lead for this customer — iTarang already has this lead in process.` <br>`Send *menu* to go back.`
  - **Hinglish:** `⚠️ Is customer ka ek lead pehle se hi iTarang ke paas process mein hai (*{ref}*).` <br>`Ye documents pehle se us lead se juda hain, isliye aap is customer ke liye naya lead nahi bana sakte — iTarang ke paas ye lead pehle se process mein hai.` <br>`Wapas jaane ke liye *menu* bhejein.`
  - **Hindi:** `⚠️ इस ग्राहक का एक लीड पहले से ही iTarang के पास प्रक्रिया में है (*{ref}*).` <br>`ये दस्तावेज़ पहले से उस लीड से जुड़े हैं, इसलिए आप इस ग्राहक के लिए नया लीड नहीं बना सकते — iTarang के पास यह लीड पहले से प्रक्रिया में है।` <br>`वापस जाने के लिए *menu* भेजें।`

### C13. Documents received → move to consent
- 🤖 **Bot:**
  - **EN:** `Thanks — documents received and details extracted. ✅` <br>`Now let's get the customer's *KYC consent*. Generating the consent form…`
  - **Hinglish:** `Dhanyavaad — documents mil gaye aur details nikaal li gayi. ✅` <br>`Ab customer ki *KYC consent* lete hain. Consent form bana raha hoon…`
  - **Hindi:** `धन्यवाद — दस्तावेज़ मिल गए और जानकारी निकाल ली गई। ✅` <br>`अब ग्राहक की *KYC सहमति* लेते हैं। सहमति फ़ॉर्म बना रहा हूँ…`

### C14. How to collect the signature
- 👤 **User gives:** taps **📞 Call** / **✍ Manual**
- 🤖 **Bot:**
  - **EN:** `How would you like to get the customer's *signature* on the consent?` — buttons: **📞 Call**, **✍ Manual**
  - **Hinglish:** `Aap consent par customer ke *signature* kaise lena chahenge?` — buttons: **📞 Call**, **✍ Manual**
  - **Hindi:** `आप सहमति पर ग्राहक के *हस्ताक्षर* कैसे लेना चाहेंगे?` — buttons: **📞 कॉल**, **✍ मैन्युअल**

### C15. Consent preview / signed PDF captions
| Caption | 🤖 EN | 🤖 Hinglish | 🤖 Hindi |
|---|---|---|---|
| Preview | `📄 Customer KYC consent form` | `📄 Customer KYC consent form` | `📄 ग्राहक KYC सहमति फ़ॉर्म` |
| Manual print | `✍ Print this, get the customer's signature, then *upload the signed PDF here*.` | `✍ Ise print karein, customer ka signature lein, phir *signed PDF yahaan upload karein*.` | `✍ इसे प्रिंट करें, ग्राहक के हस्ताक्षर लें, फिर *हस्ताक्षरित PDF यहाँ अपलोड करें*।` |

### C16. Call OTP consent
- 👤 **User gives:** types the 6-digit OTP
- 🤖 **Bot:**
  - **EN:** `🔐 A 6-digit OTP was sent to the customer via *Call* on {otpSentTo}.` <br>`Ask the customer to read it out, then *type the 6 digits here* to record their consent.` — button: **🔁 Resend OTP**
  - **Hinglish:** `🔐 Customer ko {otpSentTo} par *Call* ke through 6-digit OTP bheja gaya hai.` <br>`Customer se use bolne ke liye kahein, phir unki consent record karne ke liye *ye 6 digit yahaan type karein*.` — button: **🔁 Resend OTP**
  - **Hindi:** `🔐 ग्राहक को {otpSentTo} पर *कॉल* के ज़रिए 6-अंकों का OTP भेजा गया है।` <br>`ग्राहक से उसे बोलने के लिए कहें, फिर उनकी सहमति दर्ज करने के लिए *ये 6 अंक यहाँ टाइप करें*।` — button: **🔁 OTP दोबारा भेजें**

### C17. Consent recorded / signed successfully
| Event | 🤖 EN | 🤖 Hinglish | 🤖 Hindi |
|---|---|---|---|
| OTP recorded | `✅ *Consent recorded.* Thank you!` | `✅ *Consent record ho gaya.* Dhanyavaad!` | `✅ *सहमति दर्ज हो गई।* धन्यवाद!` |
| Signed received | `✅ *Signed consent received.*` | `✅ *Signed consent mil gaya.*` | `✅ *हस्ताक्षरित सहमति मिल गई।*` |
| Customer signed | `✅ *Customer signed the consent successfully!*` | `✅ *Customer ne consent safaltapoorvak sign kar diya!*` | `✅ *ग्राहक ने सहमति सफलतापूर्वक हस्ताक्षरित कर दी!*` |

### C18. Waiting for signature
- 👤 **User gives:** taps **✅ Check if signed** / uploads signed PDF
- 🤖 **Bot:**
  - **EN:** `⏳ Waiting for the customer to sign the consent — tap *Check if signed* once they have, and I'll confirm here.` <br>`Collecting the signature *manually*? Upload the signed PDF here. Send *menu* to exit.`
  - **Hinglish:** `⏳ Customer ke consent sign karne ka intezaar hai — jab wo kar dein to *Check if signed* tap karein, main yahaan confirm kar doonga.` <br>`Signature *manually* le rahe hain? Signed PDF yahaan upload karein. Nikalne ke liye *menu* bhejein.`
  - **Hindi:** `⏳ ग्राहक द्वारा सहमति पर हस्ताक्षर करने की प्रतीक्षा है — जब वे कर दें तो *Check if signed* टैप करें, मैं यहाँ पुष्टि कर दूँगा।` <br>`हस्ताक्षर *मैन्युअल* ले रहे हैं? हस्ताक्षरित PDF यहाँ अपलोड करें। बाहर निकलने के लिए *menu* भेजें।`

### C19. Additional finance details (3 questions)
- 👤 **User gives:** taps an option for each
- 🤖 **Bot:**
  - **Q1 — EN:** `📋 *Additional Finance Details* (1/3)` <br>`*Resident Status*` <br>`Does the customer *own* or *rent* their current residence?` — buttons: **🏠 Owned**, **🔑 Rented**
  - **Q1 — Hinglish:** `📋 *Additional Finance Details* (1/3)` <br>`*Resident Status*` <br>`Kya customer apne current residence ka *maalik* hai ya wo *kiraye* par rehte hain?` — buttons: **🏠 Owned**, **🔑 Rented**
  - **Q1 — Hindi:** `📋 *अतिरिक्त फ़ाइनेंस विवरण* (1/3)` <br>`*निवास स्थिति*` <br>`क्या ग्राहक अपने वर्तमान निवास के *मालिक* हैं या वे *किराये* पर रहते हैं?` — buttons: **🏠 अपना**, **🔑 किराये पर**
  - **Q2 — EN:** `🩺 *Existing Health Insurance* (2/3)` <br>`Does the customer currently hold their own *health insurance* policy?` — buttons: **Yes**, **No**
  - **Q2 — Hinglish:** `🩺 *Existing Health Insurance* (2/3)` <br>`Kya customer ke paas abhi apni *health insurance* policy hai?` — buttons: **Yes**, **No**
  - **Q2 — Hindi:** `🩺 *मौजूदा स्वास्थ्य बीमा* (2/3)` <br>`क्या ग्राहक के पास अभी अपनी *स्वास्थ्य बीमा* पॉलिसी है?` — buttons: **हाँ**, **नहीं**
  - **Q3 — EN:** `💚 *Existing Life Insurance* (3/3)` <br>`Does the customer currently hold their own *life insurance* policy?` — buttons: **Yes**, **No**
  - **Q3 — Hinglish:** `💚 *Existing Life Insurance* (3/3)` <br>`Kya customer ke paas abhi apni *life insurance* policy hai?` — buttons: **Yes**, **No**
  - **Q3 — Hindi:** `💚 *मौजूदा जीवन बीमा* (3/3)` <br>`क्या ग्राहक के पास अभी अपनी *जीवन बीमा* पॉलिसी है?` — buttons: **हाँ**, **नहीं**

### C20. Finance details complete
- 🤖 **Bot:**
  - **EN:** `Thanks — that's all the finance details. ✅`
  - **Hinglish:** `Dhanyavaad — bas itni hi finance details thi. ✅`
  - **Hindi:** `धन्यवाद — बस इतनी ही फ़ाइनेंस जानकारी थी। ✅`

### C21. Submit to iTarang
- 👤 **User gives:** taps **📤 Submit to iTarang**
- 🤖 **Bot:**
  - **EN:** `Review the signed consent above. When ready, tap *Submit to iTarang* — the documents, extracted details and signed consent all go to the iTarang team for KYC review.` — button: **📤 Submit to iTarang**
  - **Hinglish:** `Upar signed consent review karein. Taiyaar hone par *Submit to iTarang* tap karein — documents, extracted details aur signed consent sab iTarang team ke paas KYC review ke liye chale jaate hain.` — button: **📤 Submit to iTarang**
  - **Hindi:** `ऊपर हस्ताक्षरित सहमति की समीक्षा करें। तैयार होने पर *Submit to iTarang* टैप करें — दस्तावेज़, निकाली गई जानकारी और हस्ताक्षरित सहमति सब iTarang टीम के पास KYC समीक्षा के लिए चले जाते हैं।` — button: **📤 iTarang को भेजें**

### C22. Final submission (terminal)
- 🤖 **Bot (customer flow):**
  - **EN:** `🎉 *Thanks! Your details have been submitted to iTarang for review.*` <br>`Your documents and signed consent have all been sent for verification. Our team will contact you shortly.`
  - **Hinglish:** `🎉 *Dhanyavaad! Aapki details iTarang ko review ke liye submit ho gayi hain.*` <br>`Aapke documents aur signed consent sab verification ke liye bhej diye gaye hain. Humaari team jaldi hi aapse sampark karegi.`
  - **Hindi:** `🎉 *धन्यवाद! आपकी जानकारी iTarang को समीक्षा के लिए सबमिट हो गई है।*` <br>`आपके दस्तावेज़ और हस्ताक्षरित सहमति सब सत्यापन के लिए भेज दिए गए हैं। हमारी टीम जल्द ही आपसे संपर्क करेगी।`
- 🤖 **Bot (dealer flow):**
  - **EN:** `🎉 *Lead submitted to iTarang for KYC review!*` <br>`The customer's documents, extracted details and signed consent have all been sent for verification.` <br>`Send *menu* to create another lead.`
  - **Hinglish:** `🎉 *Lead iTarang ko KYC review ke liye submit ho gaya!*` <br>`Customer ke documents, extracted details aur signed consent sab verification ke liye bhej diye gaye hain.` <br>`Aur lead banane ke liye *menu* bhejein.`
  - **Hindi:** `🎉 *लीड iTarang को KYC समीक्षा के लिए सबमिट हो गया!*` <br>`ग्राहक के दस्तावेज़, निकाली गई जानकारी और हस्ताक्षरित सहमति सब सत्यापन के लिए भेज दिए गए हैं।` <br>`और लीड बनाने के लिए *menu* भेजें।`

### C23. Cash lead finalized (terminal)
- 🤖 **Bot (customer flow):**
  - **EN:** `✅ *Thanks — your details have been saved!*` <br>`Name: … Mobile: … Vehicle: … Product: … Payment: Cash` <br>`Our team will contact you shortly.`
  - **Hinglish:** `✅ *Dhanyavaad — aapki details save ho gayi hain!*` <br>`Name: … Mobile: … Vehicle: … Product: … Payment: Cash` <br>`Humaari team jaldi hi aapse sampark karegi.`
  - **Hindi:** `✅ *धन्यवाद — आपकी जानकारी सहेज ली गई है!*` <br>`नाम: … मोबाइल: … वाहन: … उत्पाद: … भुगतान: नकद` <br>`हमारी टीम जल्द ही आपसे संपर्क करेगी।`
- 🤖 **Bot (dealer flow):**
  - **EN:** `✅ *Lead saved!*` <br>`Name: … Mobile: … Vehicle: … Product: … Payment: Cash` <br>`You can complete the rest on the dealer portal. Send *menu* for more.`
  - **Hinglish:** `✅ *Lead save ho gaya!*` <br>`Name: … Mobile: … Vehicle: … Product: … Payment: Cash` <br>`Baaki aap dealer portal par pura kar sakte hain. Aur ke liye *menu* bhejein.`
  - **Hindi:** `✅ *लीड सहेजा गया!*` <br>`नाम: … मोबाइल: … वाहन: … उत्पाद: … भुगतान: नकद` <br>`बाक़ी आप डीलर पोर्टल पर पूरा कर सकते हैं। और के लिए *menu* भेजें।`

---

# PART D — HELPER / MENU MESSAGES (Customer console)

### D1. Help
- 🤖 **Bot:**
  - **EN:** `❓ *iTarang Dealer Help*` <br>`• Send *menu* any time to see your options.` <br>`• *New Lead* — create a customer lead step by step.` <br>`• *Save Drafts* — resume a lead you started earlier.` <br>`• *Inventory* — see your available stock.` <br>`• Need a person? Email support@itarang.com.`
  - **Hinglish:** `❓ *iTarang Dealer Help*` <br>`• Apne options dekhne ke liye kabhi bhi *menu* bhejein.` <br>`• *New Lead* — step by step ek customer lead banayein.` <br>`• *Save Drafts* — pehle shuru kiya hua lead resume karein.` <br>`• *Inventory* — apna available stock dekhein.` <br>`• Kisi vyakti se baat karni hai? Email karein support@itarang.com.`
  - **Hindi:** `❓ *iTarang डीलर सहायता*` <br>`• अपने विकल्प देखने के लिए कभी भी *menu* भेजें।` <br>`• *नया लीड* — चरण-दर-चरण एक ग्राहक लीड बनाएं।` <br>`• *ड्राफ़्ट सहेजें* — पहले शुरू किया हुआ लीड फिर से शुरू करें।` <br>`• *इन्वेंटरी* — अपना उपलब्ध स्टॉक देखें।` <br>`• किसी व्यक्ति से बात करनी है? ईमेल करें support@itarang.com।`

### D2. No drafts
- 🤖 **Bot:**
  - **EN:** `📝 You don't have any saved drafts right now.` <br>`Tap *New Lead* from the menu to start one. Send *menu* to go back.`
  - **Hinglish:** `📝 Abhi aapke paas koi saved draft nahi hai.` <br>`Naya shuru karne ke liye menu se *New Lead* tap karein. Wapas jaane ke liye *menu* bhejein.`
  - **Hindi:** `📝 अभी आपके पास कोई सहेजा हुआ ड्राफ़्ट नहीं है।` <br>`नया शुरू करने के लिए मेन्यू से *नया लीड* टैप करें। वापस जाने के लिए *menu* भेजें।`

### D3. Inventory (available stock)
- 🤖 **Bot:**
  - **EN:** `📦 *Available Inventory*` <br>`*{Category}*` <br>`• {label} — *{available}*` <br>`*Total available units:* {n}` <br>`Send *menu* to go back.`
  - **Hinglish:** `📦 *Available Inventory*` <br>`*{Category}*` <br>`• {label} — *{available}*` <br>`*Kul available units:* {n}` <br>`Wapas jaane ke liye *menu* bhejein.`
  - **Hindi:** `📦 *उपलब्ध इन्वेंटरी*` <br>`*{Category}*` <br>`• {label} — *{available}*` <br>`*कुल उपलब्ध यूनिट:* {n}` <br>`वापस जाने के लिए *menu* भेजें।`

---

## Terminology reference (kept consistent across languages)

| English | Hinglish | Hindi |
|---|---|---|
| Dealer | Dealer | डीलर |
| Customer | Customer | ग्राहक |
| Document | Document | दस्तावेज़ |
| Financing | Financing | फ़ाइनेंसिंग |
| Consent | Consent | सहमति |
| Owner | Owner / Maalik | मालिक |
| Lead | Lead | लीड |
| Cash | Cash | नकद |
| Submit | Submit | सबमिट / भेजें |
| Menu | Menu | मेन्यू |

> **Localization note:** WhatsApp UI **button labels** are limited to 20 characters. If translated button text exceeds that, keep the English word (e.g. **Resume**, **Confirm**) — that's why several buttons above are left in English. Command keywords the bot listens for (`menu`, `hi`, `skip`, `done`, `stop`) must stay in English/Roman so the parser still matches them.
