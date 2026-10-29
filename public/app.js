"use strict";
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const state = { user:null, page:"dashboard", cache:{}, permissions:[] };
const money = cents => new Intl.NumberFormat("en-BD",{style:"currency",currency:"BDT",maximumFractionDigits:2}).format((Number(cents)||0)/100);
const dateText = d => d ? new Date(d).toLocaleString([], {dateStyle:"medium",timeStyle:"short"}) : "—";
const dateOnly = d => d ? new Date(d).toLocaleDateString([], {dateStyle:"medium"}) : "—";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const initials = s => String(s||"?").split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase();
async function api(url, options={}) {
  const opts={credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})},...options};
  if(opts.body && typeof opts.body!=="string") opts.body=JSON.stringify(opts.body);
  const response=await fetch(url,opts);
  let data={}; try { data=await response.json(); } catch(_){}
  if(response.status===401 && !url.includes("/auth/login")) { showLogin(); throw new Error(data.error||"Session expired."); }
  if(!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function toast(message,error=false){const el=$("#toast");el.textContent=message;el.className="toast show"+(error?" error":"");clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className="toast",3200);}
function showLogin(){state.user=null;$("#app").classList.add("hidden");$("#login-screen").classList.remove("hidden");$("#login-error").textContent="";$("#login-form").reset();}
function showApp(user,permissions=[]){state.user=user;state.permissions=permissions;$("#login-screen").classList.add("hidden");$("#app").classList.remove("hidden");$("#user-name").textContent=user.displayName||user.username;$("#user-role").textContent=user.role;$("#user-avatar").textContent=initials(user.displayName||user.username);$$(".admin-only").forEach(el=>el.classList.toggle("hidden",user.role!=="admin"));$("#today").textContent=new Date().toLocaleDateString([], {weekday:"short",month:"short",day:"numeric"});navigate("dashboard");}
// Remove accidental credentials/query strings from the address bar. Credentials must be entered in the form, never in the URL.
if (location.search && /(?:username|password)=/i.test(location.search)) {
  history.replaceState(null, "", location.pathname + location.hash);
}

$("#login-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  const username = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  const btn = $("button[type=submit]", e.currentTarget);
  const error = $("#login-error");
  error.textContent = "";
  if (!username || !password) {
    error.textContent = "Enter both your username and password, then try again.";
    return;
  }
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/auth/login", {method:"POST", body:{username, password}});
    const me = await api("/api/auth/me");
    showApp(result.user, me.permissions);
    toast("Welcome back.");
  } catch (err) {
    error.textContent = err.message || "Sign in failed. Please try again.";
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
});
$("#logout").addEventListener("click",async()=>{try{await api("/api/auth/logout",{method:"POST"});}catch(_){}showLogin();toast("You have signed out.");});
$("#nav").addEventListener("click",e=>{const btn=e.target.closest("[data-page]");if(btn)navigate(btn.dataset.page);});
$("#menu-toggle").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
function navigate(page){state.page=page;$$(".nav-item[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));$("#sidebar").classList.remove("open");const labels={dashboard:"Overview",patients:"Patients",appointments:"Appointments",doctors:"Doctors",beds:"Bed management",prescriptions:"Prescriptions",billing:"Billing",users:"User access",audit:"Audit log"};$("#page-title").textContent=labels[page]||"Overview";$("#crumb").textContent="HOSPITAL OPERATIONS / "+(labels[page]||"OVERVIEW").toUpperCase();renderPage().catch(e=>{if(e.message)toast(e.message,true);$("#page-content").innerHTML=`<div class="panel empty">Could not load this section. ${esc(e.message)}</div>`;});}
async function renderPage(){const c=$("#page-content");c.innerHTML='<div class="loading">Loading…</div>';const renderers={dashboard:renderDashboard,patients:renderPatients,appointments:renderAppointments,doctors:renderDoctors,beds:renderBeds,prescriptions:renderPrescriptions,billing:renderBilling,users:renderUsers,audit:renderAudit};await (renderers[state.page]||renderDashboard)();}
function statusBadge(status){const cls=({Paid:"green",Available:"green",Completed:"green",Discharged:"green",Scheduled:"blue","Checked In":"orange",Admitted:"orange","In Consultation":"blue",Unpaid:"orange",Cancelled:"red",Maintenance:"red",Occupied:"orange"})[status]||"";return `<span class="badge ${cls}">${esc(status)}</span>`;}
function person(name,sub=""){return `<div class="person"><div class="person-avatar">${esc(initials(name))}</div><div><b>${esc(name||"Unknown")}</b>${sub?`<small>${esc(sub)}</small>`:""}</div></div>`;}
function emptyRow(n,msg){return `<tr><td colspan="${n}" class="empty">${esc(msg)}</td></tr>`;}
function sectionTitle(title,subtitle,action=""){return `<div class="section-title"><div><h2>${title}</h2><p>${subtitle}</p></div>${action}</div>`;}
async function renderDashboard(){
let d=await api("/api/dashboard");
// Be tolerant of older/mismatched API response shapes so the dashboard does not crash.
let m=d && d.metrics;
let upcoming=Array.isArray(d && d.upcoming)?d.upcoming:[];
if(!m || typeof m!=="object"){
  const [pd,dd,ad,bd,id]=await Promise.all([
    api("/api/patients"),api("/api/doctors"),api("/api/appointments"),api("/api/beds"),api("/api/invoices")
  ]);
  const patients=Array.isArray(pd.patients)?pd.patients:[];
  const doctors=Array.isArray(dd.doctors)?dd.doctors:[];
  const appointments=Array.isArray(ad.appointments)?ad.appointments:[];
  const beds=Array.isArray(bd.beds)?bd.beds:[];
  const invoices=Array.isArray(id.invoices)?id.invoices:[];
  const today=new Date().toISOString().slice(0,10);
  m={patients:patients.length,doctors:doctors.filter(x=>x.active).length,
    appointmentsToday:appointments.filter(x=>String(x.appointment_at||"").slice(0,10)===today&&x.status!=="Cancelled").length,
    availableBeds:beds.filter(x=>x.status==="Available").length,
    occupiedBeds:beds.filter(x=>x.status==="Occupied").length,
    paidRevenueCents:invoices.filter(x=>x.status==="Paid").reduce((sum,x)=>sum+(Number(x.amount_cents)||0),0),
    unpaidCents:invoices.filter(x=>x.status==="Unpaid").reduce((sum,x)=>sum+(Number(x.amount_cents)||0),0)};
  upcoming=appointments.filter(x=>["Scheduled","Checked In"].includes(x.status)).sort((a,b)=>new Date(a.appointment_at)-new Date(b.appointment_at)).slice(0,6);
}
for(const key of ["patients","doctors","appointmentsToday","availableBeds","occupiedBeds","paidRevenueCents","unpaidCents"]) if(!Number.isFinite(Number(m[key]))) m[key]=0;
if(!Array.isArray(upcoming)) upcoming=[];
$("#page-content").innerHTML=`
<div class="grid metrics">
<div class="metric"><div class="metric-head">Total patients <span class="metric-icon">♙</span></div><div class="metric-value">${m.patients}</div><div class="metric-foot">Registered patient records</div></div>
<div class="metric"><div class="metric-head">Active doctors <span class="metric-icon">✚</span></div><div class="metric-value">${m.doctors}</div><div class="metric-foot">Medical team members</div></div>
<div class="metric"><div class="metric-head">Today's appointments <span class="metric-icon">▦</span></div><div class="metric-value">${m.appointmentsToday}</div><div class="metric-foot">Scheduled for today</div></div>
<div class="metric"><div class="metric-head">Available beds <span class="metric-icon">▤</span></div><div class="metric-value">${m.availableBeds}</div><div class="metric-foot">${m.occupiedBeds} currently occupied</div></div>
</div>
<div class="grid dashboard-grid">
<div class="panel"><div class="panel-head"><div><h2>Upcoming appointments</h2><p>Latest scheduled and checked-in visits</p></div><button class="btn btn-secondary btn-small" data-goto="appointments">View all →</button></div>
<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Doctor</th><th>Schedule</th><th>Status</th></tr></thead><tbody>${upcoming.length?upcoming.map(a=>`<tr><td>${person(a.patient_name,a.reason)}</td><td>${esc(a.doctor_name)}</td><td>${dateText(a.appointment_at)}</td><td>${statusBadge(a.status)}</td></tr>`).join(""):emptyRow(4,"No upcoming appointments yet.")}</tbody></table></div></div>
<div class="panel"><div class="panel-head"><div><h2>Financial snapshot</h2><p>Recorded invoice totals</p></div><span class="metric-icon">৳</span></div>
<div class="stat-line"><span>Paid revenue</span><b>${money(m.paidRevenueCents)}</b></div><div class="stat-line"><span>Outstanding invoices</span><b>${money(m.unpaidCents)}</b></div>
<div class="stat-line"><span>Bed occupancy</span><b>${m.occupiedBeds} / ${m.occupiedBeds+m.availableBeds}</b></div><div class="progress"><span style="width:${m.occupiedBeds+m.availableBeds?Math.round(m.occupiedBeds/(m.occupiedBeds+m.availableBeds)*100):0}%"></span></div>
<p class="small muted" style="line-height:1.7;margin-top:20px">This dashboard displays operational records only. It does not provide clinical decision support or payment processing.</p></div>
</div>
<div class="panel" style="margin-top:18px"><div class="panel-head"><div><h2>Quick actions</h2><p>Jump into common workflows</p></div></div><div class="toolbar">
<button class="btn btn-primary" data-action="add-patient">＋ Register patient</button><button class="btn btn-secondary" data-goto="appointments">＋ Schedule appointment</button><button class="btn btn-secondary" data-goto="beds">Manage beds</button><button class="btn btn-secondary" data-goto="billing">View billing</button></div></div>`;
$$("[data-goto]").forEach(b=>b.onclick=()=>navigate(b.dataset.goto));$$("[data-action=add-patient]").forEach(b=>b.onclick=()=>patientModal());}
async function renderPatients(){const d=await api("/api/patients");state.cache.patients=d.patients;$("#page-content").innerHTML=sectionTitle("Patient directory","Create and maintain patient demographic records.",'<button class="btn btn-primary" id="add-patient">＋ Add patient</button>')+`
<div class="panel"><div class="toolbar"><input id="patient-search" placeholder="Search name, phone or ID…" aria-label="Search patients"><select id="patient-status"><option value="">All statuses</option><option>Outpatient</option><option>Admitted</option><option>In Consultation</option><option>Discharged</option></select><span class="spacer"></span><span class="small muted">${d.patients.length} record(s)</span></div>
<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Patient ID</th><th>Age / DOB</th><th>Blood group</th><th>Doctor</th><th>Status</th><th>Actions</th></tr></thead><tbody id="patients-body">${patientRows(d.patients)}</tbody></table></div></div>`;
$("#add-patient").onclick=()=>patientModal();const filter=()=>{const q=$("#patient-search").value.toLowerCase(),s=$("#patient-status").value;const rows=d.patients.filter(p=>(`${p.full_name} ${p.phone||""} ${p.id}`).toLowerCase().includes(q)&&(!s||p.status===s));$("#patients-body").innerHTML=patientRows(rows);wirePatientActions();};$("#patient-search").oninput=filter;$("#patient-status").onchange=filter;wirePatientActions();}
function patientRows(rows){return rows.length?rows.map(p=>`<tr><td>${person(p.full_name,p.phone||p.email||"No contact")}</td><td>${esc(p.id)}</td><td>${esc(p.date_of_birth||"—")}</td><td>${esc(p.blood_group||"Unknown")}</td><td>${esc(p.doctor_name||"Unassigned")}</td><td>${statusBadge(p.status)}</td><td><button class="btn btn-secondary btn-small" data-edit-patient="${esc(p.id)}">Edit</button> <button class="btn btn-danger btn-small" data-delete-patient="${esc(p.id)}">Delete</button></td></tr>`).join(""):emptyRow(7,"No patient records match this search.");}
function wirePatientActions(){$$("[data-edit-patient]").forEach(b=>b.onclick=()=>patientModal(state.cache.patients.find(p=>p.id===b.dataset.editPatient)));$$("[data-delete-patient]").forEach(b=>b.onclick=async()=>{if(!confirm("Delete this patient record? Linked records may prevent deletion."))return;try{await api(`/api/patients/${encodeURIComponent(b.dataset.deletePatient)}`,{method:"DELETE"});toast("Patient record deleted.");renderPatients();}catch(e){toast(e.message,true);}});}
async function doctorsOptions(selected=""){const d=await api("/api/doctors");return d.doctors.filter(x=>x.active).map(x=>`<option value="${esc(x.id)}" ${x.id===selected?"selected":""}>${esc(x.full_name)} — ${esc(x.specialty)}</option>`).join("");}
async function patientModal(p=null){const doctors=await doctorsOptions(p?.doctor_id||"");openModal(p?"Edit patient":"Register patient",`<form id="record-form"><div class="form-grid">
${field("Full name","full_name",p?.full_name||"",true)}${field("Date of birth","date_of_birth",p?.date_of_birth||"",false,"date")}
${selectField("Gender","gender",["Female","Male","Other","Prefer not to say"],p?.gender||"Female")}${field("Phone","phone",p?.phone||"")}
${field("Email","email",p?.email||"","", "email")}${selectField("Blood group","blood_group",["A+","A-","B+","B-","AB+","AB-","O+","O-","Unknown"],p?.blood_group||"Unknown")}
${field("Address","address",p?.address||"")}${field("Emergency contact","emergency_contact",p?.emergency_contact||"")}
${selectField("Status","status",["Outpatient","Admitted","In Consultation","Discharged"],p?.status||"Outpatient")}
<div class="field"><label>Assigned doctor<select name="doctor_id"><option value="">Unassigned</option>${doctors}</select></label></div>
${selectField("Allergies","allergies",[],p?.allergies||"","text",true)}${field("Notes","notes",p?.notes||"",false,"textarea",true)}
</div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" type="submit">${p?"Save changes":"Create patient"}</button></div></form>`);
$("#record-form").onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));try{await api(p?`/api/patients/${encodeURIComponent(p.id)}`:"/api/patients",{method:p?"PUT":"POST",body:data});closeModal();toast(p?"Patient updated.":"Patient registered.");navigate("patients");}catch(err){toast(err.message,true);}};}
function field(label,name,value="",required=false,type="text",full=false){return `<div class="field ${full?"full":""}"><label>${label}<input name="${name}" type="${type==="textarea"?"text":type}" value="${esc(value)}" ${required?"required":""} maxlength="${name==="notes"?1000:300}"></label></div>`;}
function selectField(label,name,options,value="",type="select",full=false){if(type==="text")return `<div class="field ${full?"full":""}"><label>${label}<input name="${name}" value="${esc(value)}" maxlength="500"></label></div>`;return `<div class="field ${full?"full":""}"><label>${label}<select name="${name}">${options.map(o=>`<option ${o===value?"selected":""}>${esc(o)}</option>`).join("")}</select></label></div>`;}
async function renderDoctors(){const d=await api("/api/doctors");state.cache.doctors=d.doctors;$("#page-content").innerHTML=sectionTitle("Medical team","Directory of doctors and specialties.")+`<div class="grid doctor-grid">${d.doctors.map(x=>`<article class="doctor-card"><div class="doctor-top"><div class="doctor-avatar">${esc(initials(x.full_name))}</div><div><h3>${esc(x.full_name)}</h3><p>${esc(x.specialty)}</p></div></div><div class="doctor-details"><span>▣ Room: ${esc(x.room||"Not assigned")}</span><span>☎ ${esc(x.phone||"No phone recorded")}</span><span>✉ ${esc(x.email||"No email recorded")}</span><div>${x.active?'<span class="badge green">Active</span>':'<span class="badge red">Inactive</span>'}</div></div></article>`).join("")||'<div class="panel empty">No doctors added.</div>'}</div>`;}
async function renderAppointments(){const [a,p,ds]=await Promise.all([api("/api/appointments"),api("/api/patients"),api("/api/doctors")]);state.cache.appointments=a.appointments;state.cache.patients=p.patients;state.cache.doctors=ds.doctors;$("#page-content").innerHTML=sectionTitle("Appointments","Schedule visits and update their workflow status.",'<button class="btn btn-primary" id="add-appointment">＋ New appointment</button>')+`<div class="panel"><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Doctor</th><th>Date & time</th><th>Reason</th><th>Status</th><th>Update</th></tr></thead><tbody>${a.appointments.map(x=>`<tr><td>${person(x.patient_name,x.patient_id)}</td><td>${esc(x.doctor_name)}</td><td>${dateText(x.appointment_at)}</td><td>${esc(x.reason)}</td><td>${statusBadge(x.status)}</td><td><select data-appointment-status="${esc(x.id)}" class="inline-select">${["Scheduled","Checked In","Completed","Cancelled"].map(s=>`<option ${s===x.status?"selected":""}>${s}</option>`).join("")}</select></td></tr>`).join("")||emptyRow(6,"No appointments scheduled.")}</tbody></table></div></div>`;
$("#add-appointment").onclick=()=>appointmentModal();$$("[data-appointment-status]").forEach(sel=>sel.onchange=async()=>{try{await api(`/api/appointments/${encodeURIComponent(sel.dataset.appointmentStatus)}/status`,{method:"PATCH",body:{status:sel.value}});toast("Appointment status updated.");}catch(e){toast(e.message,true);renderAppointments();}});}
async function appointmentModal(){const [patients,doctors]=await Promise.all([api("/api/patients"),api("/api/doctors")]);openModal("Schedule appointment",`<form id="record-form"><div class="form-grid">
<div class="field full"><label>Patient<select name="patient_id" required>${patients.patients.map(p=>`<option value="${esc(p.id)}">${esc(p.full_name)} (${esc(p.id)})</option>`).join("")}</select></label></div>
<div class="field full"><label>Doctor<select name="doctor_id" required>${doctors.doctors.filter(d=>d.active).map(d=>`<option value="${esc(d.id)}">${esc(d.full_name)} — ${esc(d.specialty)}</option>`).join("")}</select></label></div>
${field("Date & time","appointment_at","",true,"datetime-local")}${field("Reason for visit","reason","",true)}
${selectField("Status","status",["Scheduled","Checked In","Completed","Cancelled"],"Scheduled")}${field("Notes","notes","")}
</div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary">Schedule visit</button></div></form>`);
$("#record-form").onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));f.appointment_at=new Date(f.appointment_at).toISOString();try{await api("/api/appointments",{method:"POST",body:f});closeModal();toast("Appointment scheduled.");navigate("appointments");}catch(err){toast(err.message,true);}};}
async function renderBeds(){const d=await api("/api/beds"),p=await api("/api/patients");state.cache.beds=d.beds;state.cache.patients=p.patients;const groups=[...new Set(d.beds.map(b=>b.ward))];$("#page-content").innerHTML=sectionTitle("Bed management","Track occupancy and maintenance status.")+groups.map(g=>`<div class="panel" style="margin-bottom:18px"><div class="panel-head"><div><h2>${esc(g)}</h2><p>${d.beds.filter(b=>b.ward===g).length} bed(s)</p></div></div><div class="grid bed-grid">${d.beds.filter(b=>b.ward===g).map(b=>`<div class="bed-card"><div class="bed-id">${esc(b.id)}</div><div class="bed-ward">${esc(b.bed_type)}</div>${statusBadge(b.status)}<div class="bed-patient">${esc(b.patient_name||"No patient assigned")}</div><select data-bed="${esc(b.id)}" aria-label="Update status for ${esc(b.id)}"><option ${b.status==="Available"?"selected":""}>Available</option><option ${b.status==="Occupied"?"selected":""}>Occupied</option><option ${b.status==="Maintenance"?"selected":""}>Maintenance</option></select></div>`).join("")}</div></div>`).join("")||'<div class="panel empty">No beds configured.</div>';
$$("[data-bed]").forEach(sel=>sel.onchange=()=>bedStatusModal(sel.dataset.bed,sel.value));}
async function bedStatusModal(bedId,status){if(status!=="Occupied"){try{await api(`/api/beds/${encodeURIComponent(bedId)}`,{method:"PATCH",body:{status,patient_id:""}});toast("Bed status updated.");renderBeds();}catch(e){toast(e.message,true);renderBeds();}return;}const p=state.cache.patients||[];openModal(`Assign ${bedId}`,`<form id="record-form"><div class="field"><label>Patient<select name="patient_id" required>${p.map(x=>`<option value="${esc(x.id)}">${esc(x.full_name)} (${esc(x.id)})</option>`).join("")}</select></label></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary">Assign bed</button></div></form>`);$("#record-form").onsubmit=async e=>{e.preventDefault();try{await api(`/api/beds/${encodeURIComponent(bedId)}`,{method:"PATCH",body:{status:"Occupied",patient_id:new FormData(e.currentTarget).get("patient_id")}});closeModal();toast("Bed assigned.");renderBeds();}catch(err){toast(err.message,true);}};}
async function renderPrescriptions(){const [r,p,d]=await Promise.all([api("/api/prescriptions"),api("/api/patients"),api("/api/doctors")]);state.cache.patients=p.patients;state.cache.doctors=d.doctors;$("#page-content").innerHTML=sectionTitle("Prescriptions","Record medication instructions. Clinical review remains the prescriber's responsibility.",'<button class="btn btn-primary" id="add-rx">＋ New prescription</button>')+`<div class="panel"><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Prescriber</th><th>Medication</th><th>Dosage</th><th>Frequency</th><th>Duration</th><th>Created</th></tr></thead><tbody>${r.prescriptions.map(x=>`<tr><td>${person(x.patient_name,x.patient_id)}</td><td>${esc(x.doctor_name)}</td><td><b>${esc(x.medication)}</b><small class="muted" style="display:block;margin-top:4px">${esc(x.instructions||"")}</small></td><td>${esc(x.dosage)}</td><td>${esc(x.frequency)}</td><td>${esc(x.duration)}</td><td>${dateOnly(x.created_at)}</td></tr>`).join("")||emptyRow(7,"No prescriptions recorded.")}</tbody></table></div></div>`;
$("#add-rx").onclick=()=>prescriptionModal();}
async function prescriptionModal(){if(!["admin","doctor"].includes(state.user.role)){toast("Only doctors or administrators can create prescriptions.",true);return;}const [p,d]=await Promise.all([api("/api/patients"),api("/api/doctors")]);openModal("Create prescription",`<form id="record-form"><div class="form-grid">
<div class="field full"><label>Patient<select name="patient_id" required>${p.patients.map(x=>`<option value="${esc(x.id)}">${esc(x.full_name)} (${esc(x.id)})</option>`).join("")}</select></label></div>
<div class="field full"><label>Prescribing doctor<select name="doctor_id" required>${d.doctors.filter(x=>x.active).map(x=>`<option value="${esc(x.id)}">${esc(x.full_name)}</option>`).join("")}</select></label></div>
${field("Medication","medication","",true)}${field("Dosage","dosage","",true)}${field("Frequency","frequency","",true)}${field("Duration","duration","",true)}${field("Instructions","instructions","",false,"textarea",true)}
</div><p class="small muted">This tool stores documentation only; it does not verify interactions or recommend medication.</p><div class="modal-actions"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary">Save prescription</button></div></form>`);
$("#record-form").onsubmit=async e=>{e.preventDefault();try{await api("/api/prescriptions",{method:"POST",body:Object.fromEntries(new FormData(e.currentTarget))});closeModal();toast("Prescription saved.");navigate("prescriptions");}catch(err){toast(err.message,true);}};}
async function renderBilling(){const d=await api("/api/invoices"),p=await api("/api/patients");state.cache.patients=p.patients;$("#page-content").innerHTML=sectionTitle("Billing & invoices","Track invoice records. No real payment processing is included.",'<button class="btn btn-primary" id="add-invoice">＋ Create invoice</button>')+`<div class="panel"><div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Patient</th><th>Description</th><th>Amount</th><th>Due date</th><th>Status</th><th>Update</th></tr></thead><tbody>${d.invoices.map(x=>`<tr><td><b>${esc(x.id)}</b></td><td>${person(x.patient_name,x.patient_id)}</td><td>${esc(x.description)}</td><td><b>${money(x.amount_cents)}</b></td><td>${esc(x.due_date||"—")}</td><td>${statusBadge(x.status)}</td><td><select class="inline-select" data-invoice="${esc(x.id)}"><option ${x.status==="Unpaid"?"selected":""}>Unpaid</option><option ${x.status==="Paid"?"selected":""}>Paid</option><option ${x.status==="Cancelled"?"selected":""}>Cancelled</option></select></td></tr>`).join("")||emptyRow(7,"No invoices recorded.")}</tbody></table></div></div>`;
$("#add-invoice").onclick=()=>invoiceModal();$$("[data-invoice]").forEach(sel=>sel.onchange=async()=>{try{await api(`/api/invoices/${encodeURIComponent(sel.dataset.invoice)}/status`,{method:"PATCH",body:{status:sel.value}});toast("Invoice status updated.");}catch(e){toast(e.message,true);renderBilling();}});}
async function invoiceModal(){const p=await api("/api/patients");openModal("Create invoice",`<form id="record-form"><div class="form-grid"><div class="field full"><label>Patient<select name="patient_id" required>${p.patients.map(x=>`<option value="${esc(x.id)}">${esc(x.full_name)} (${esc(x.id)})</option>`).join("")}</select></label></div>
${field("Description","description","",true)}${field("Amount (BDT)","amount","",true,"number")}${field("Due date","due_date","",false,"date")}${selectField("Status","status",["Unpaid","Paid","Cancelled"],"Unpaid")}</div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary">Create invoice</button></div></form>`);
const amount=$('[name="amount"]');amount.min="0";amount.step="0.01";$("#record-form").onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));f.amount=Number(f.amount);try{await api("/api/invoices",{method:"POST",body:f});closeModal();toast("Invoice created.");navigate("billing");}catch(err){toast(err.message,true);}};}
async function renderUsers(){const d=await api("/api/users");$("#page-content").innerHTML=sectionTitle("User access","Create named accounts and manage their roles.",'<button class="btn btn-primary" id="add-user">＋ Add user</button>')+`<div class="panel"><div class="table-wrap"><table><thead><tr><th>User</th><th>Username</th><th>Role</th><th>Created</th><th>Access</th><th>Action</th></tr></thead><tbody>${d.users.map(u=>`<tr><td>${person(u.display_name,u.id)}</td><td>${esc(u.username)}</td><td>${statusBadge(u.role)}</td><td>${dateOnly(u.created_at)}</td><td>${u.active?'<span class="badge green">Active</span>':'<span class="badge red">Disabled</span>'}</td><td>${u.id===state.user.id?'<span class="muted">Current user</span>':`<button class="btn ${u.active?"btn-danger":"btn-secondary"} btn-small" data-user-active="${esc(u.id)}" data-active="${u.active?"true":"false"}">${u.active?"Disable":"Enable"}</button>`}</td></tr>`).join("")}</tbody></table></div></div>`;
$("#add-user").onclick=()=>userModal();$$("[data-user-active]").forEach(b=>b.onclick=async()=>{if(!confirm(`${b.dataset.active==="true"?"Disable":"Enable"} this account?`))return;try{await api(`/api/users/${encodeURIComponent(b.dataset.userActive)}/active`,{method:"PATCH",body:{active:b.dataset.active!=="true"}});toast("User access updated.");renderUsers();}catch(e){toast(e.message,true);}});}
function userModal(){openModal("Create user account",`<form id="record-form"><div class="form-grid">${field("Display name","display_name","",true)}${field("Username","username","",true)}${field("Temporary password (12+ chars)","password","",true,"password")}${selectField("Role","role",["admin","doctor","nurse","receptionist","accountant"],"receptionist")}</div><p class="small muted">Share credentials securely. Users should change their password through an approved account-management workflow; password reset is not implemented in this demo.</p><div class="modal-actions"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary">Create account</button></div></form>`);$("#record-form").onsubmit=async e=>{e.preventDefault();try{await api("/api/users",{method:"POST",body:Object.fromEntries(new FormData(e.currentTarget))});closeModal();toast("User account created.");renderUsers();}catch(err){toast(err.message,true);}};}
async function renderAudit(){const d=await api("/api/audit-logs");$("#page-content").innerHTML=sectionTitle("Audit log","Recent administrative and record-management events. Logs avoid storing raw IP addresses.")+`<div class="panel"><div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Record ID</th><th>Details</th></tr></thead><tbody>${d.logs.map(x=>`<tr><td>${dateText(x.created_at)}</td><td>${esc(x.actor_username||"System/unknown")}</td><td>${statusBadge(x.action)}</td><td>${esc(x.entity_type)}</td><td>${esc(x.entity_id||"—")}</td><td><span class="audit-detail" title="${esc(x.details||"")}">${esc(x.details||"—")}</span></td></tr>`).join("")||emptyRow(6,"No audit events yet.")}</tbody></table></div></div>`;}
function openModal(title,html){closeModal();const root=$("#modal-root");root.innerHTML=`<div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close dialog">✕</button></div><div class="modal-body">${html}</div></section></div>`;$$("[data-close]",root).forEach(b=>b.onclick=closeModal);$(".modal-backdrop",root).addEventListener("click",e=>{if(e.target.classList.contains("modal-backdrop"))closeModal();});document.addEventListener("keydown",escapeModal,{once:true});}
function escapeModal(e){if(e.key==="Escape")closeModal();}
function closeModal(){$("#modal-root").innerHTML="";}
(async function boot(){try{const me=await api("/api/auth/me");showApp(me.user,me.permissions);}catch(_){showLogin();}})();
