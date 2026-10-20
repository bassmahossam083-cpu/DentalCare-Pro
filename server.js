require('dotenv').config();
const express=require('express'), session=require('express-session'), helmet=require('helmet'), rateLimit=require('express-rate-limit'), Database=require('better-sqlite3'), bcrypt=require('bcryptjs'), path=require('path');
if(!process.env.SESSION_SECRET||!process.env.ADMIN_PASSWORD){console.error('Please configure SESSION_SECRET and ADMIN_PASSWORD in .env');process.exit(1)}
const app=express(), db=new Database(path.join(__dirname,'appointments.sqlite'));
db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL, service TEXT NOT NULL, day TEXT NOT NULL, start TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 30, source TEXT NOT NULL CHECK(source IN ('web','clinic')), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')), notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_bookings_day ON bookings(day,status);`);
// Demo patient registry. The local SQLite file is not suitable for real patient information.
db.exec(`CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, phone TEXT NOT NULL, national_id TEXT UNIQUE, age INTEGER, nationality TEXT, gender TEXT NOT NULL CHECK(gender IN ('male','female')), created_at TEXT DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);`);
db.exec(`CREATE TABLE IF NOT EXISTS treatment_plans(id INTEGER PRIMARY KEY AUTOINCREMENT,patient_id INTEGER NOT NULL REFERENCES patients(id),title TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',total_cost REAL NOT NULL DEFAULT 0 CHECK(total_cost>=0),created_at TEXT DEFAULT CURRENT_TIMESTAMP);CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT,plan_id INTEGER NOT NULL REFERENCES treatment_plans(id),amount REAL NOT NULL CHECK(amount>0),note TEXT NOT NULL DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// FDI adult permanent teeth. One procedure creates one linked treatment plan (no duplicated cost).
db.exec(`CREATE TABLE IF NOT EXISTS dental_procedures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  tooth_code INTEGER NOT NULL CHECK(tooth_code BETWEEN 11 AND 48),
  procedure_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  plan_id INTEGER NOT NULL UNIQUE REFERENCES treatment_plans(id),
  created_by TEXT NOT NULL CHECK(created_by IN ('doctor','reception')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dental_patient ON dental_procedures(patient_id);`);
const validTooth = n => Number.isInteger(n) && [1,2,3,4].includes(Math.floor(n/10)) && n%10>=1 && n%10<=8;
const dentalTypes=['فحص','حشوة','علاج عصب','خلع','تركيبة','زراعة','تنظيف','تقويم','علاج لثة','أخرى'];
const cols=db.prepare('PRAGMA table_info(bookings)').all().map(x=>x.name);
if(!cols.includes('patient_id'))db.exec('ALTER TABLE bookings ADD COLUMN patient_id INTEGER REFERENCES patients(id)');
if(!cols.includes('visit_status'))db.exec("ALTER TABLE bookings ADD COLUMN visit_status TEXT NOT NULL DEFAULT 'scheduled'");
const audit=db.prepare('CREATE TABLE IF NOT EXISTS appointment_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL, role TEXT NOT NULL, old_status TEXT, new_status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');audit.run();
// V7 demonstration invoices: access is restricted to reception on the server.
db.exec(`CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES patients(id), description TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('paid','unpaid')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
const receptionOnly=(req,res,next)=>req.session.role==='reception'?next():res.status(403).json({error:'هذه الصلاحية مخصصة لموظفة الاستقبال'});
const tz='Asia/Riyadh';
const validDay=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(new Date(d+'T12:00:00Z').getTime())&&new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;
const min=t=>{if(!/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(t))return null;const [h,m]=t.split(':').map(Number);return h*60+m};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const nowMinutes=()=>{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date()).split(':').map(Number);return parts[0]*60+parts[1]};
function slotsFor(day,duration=30,ignore=null){let out=[];if(!validDay(day)||day<today()||day>new Date(Date.now()+90*864e5).toISOString().slice(0,10))return out;const occupied=db.prepare("SELECT start,duration FROM bookings WHERE day=? AND status != 'cancelled' AND id != ?").all(day,ignore||0);for(let n=16*60;n+duration<=22*60;n+=30){if(day===today()&&n<=nowMinutes())continue;if(!occupied.some(b=>n<min(b.start)+b.duration&&min(b.start)<n+duration))out.push(`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`)}return out}
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'10kb'}));app.use(session({name:'clinic.sid',secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*3600000}}));app.use(express.static(path.join(__dirname,'public')));
const safe=str=>typeof str==='string'?str.trim():'';
app.get('/api/slots',(req,res)=>{const day=safe(req.query.day);if(!validDay(day))return res.status(400).json({error:'تاريخ غير صحيح'});res.json({slots:slotsFor(day)})});
function insertBooking(b){const transaction=db.transaction(()=>{if(!slotsFor(b.day,b.duration).includes(b.start))throw Error('SLOT_TAKEN');return db.prepare('INSERT INTO bookings(name,phone,service,day,start,duration,source,status,notes) VALUES (?,?,?,?,?,?,?,?,?)').run(b.name,b.phone,b.service,b.day,b.start,b.duration,b.source,b.status,b.notes).lastInsertRowid});return transaction.immediate()}
const bookingLimit=rateLimit({windowMs:15*60000,limit:15,standardHeaders:'draft-7',legacyHeaders:false});
app.post('/api/book',bookingLimit,(req,res)=>{const b={name:safe(req.body.name),phone:safe(req.body.phone),service:safe(req.body.service),day:safe(req.body.day),start:safe(req.body.start),duration:30,source:'web',status:'pending',notes:safe(req.body.notes)};if(b.name.length<2||b.name.length>80||!/^\+?[0-9\s-]{9,18}$/.test(b.phone)||b.service.length<2||b.service.length>80||b.notes.length>400||!validDay(b.day)||min(b.start)===null)return res.status(400).json({error:'تحققي من بيانات الحجز'});try{const id=insertBooking(b);res.status(201).json({id,message:'تم استلام الطلب، سيتواصل معك فريق العيادة لتأكيده'})}catch(e){res.status(409).json({error:'هذا الوقت غير متاح. اختاري وقتاً آخر'})}});
const hashes={doctor:bcrypt.hashSync(process.env.DOCTOR_PASSWORD||process.env.ADMIN_PASSWORD,10),reception:bcrypt.hashSync(process.env.RECEPTION_PASSWORD||process.env.ADMIN_PASSWORD,10)};
app.post('/api/login',rateLimit({windowMs:15*60000,limit:12}),async(req,res)=>{const role=safe(req.body.role),pass=safe(req.body.password);if(!['doctor','reception'].includes(role)||!await bcrypt.compare(pass,hashes[role]||hashes.doctor))return res.status(401).json({error:'بيانات الدخول غير صحيحة'});req.session.role=role;res.json({role})});
app.get('/api/me',(req,res)=>res.json({role:req.session.role||null}));
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
function auth(req,res,next){if(!req.session.role)return res.status(401).json({error:'يجب تسجيل الدخول'});next()}
app.get('/api/admin/bookings',auth,(req,res)=>{const day=safe(req.query.day);if(!validDay(day))return res.status(400).json({error:'تاريخ غير صحيح'});res.json(db.prepare("SELECT * FROM bookings WHERE day=? AND status != 'cancelled' ORDER BY start,id").all(day))});
app.post('/api/admin/bookings',auth,(req,res)=>{const selected=numericId(req.body.patient_id),person=selected?db.prepare('SELECT * FROM patients WHERE id=?').get(selected):null;if(selected&&!person)return res.status(400).json({error:'ملف المريض غير موجود'});const b={name:person?person.full_name:safe(req.body.name),phone:person?person.phone:safe(req.body.phone),service:safe(req.body.service)||'موعد عيادة',day:safe(req.body.day),start:safe(req.body.start),duration:Number(req.body.duration)||30,source:'clinic',status:'confirmed',notes:safe(req.body.notes)};if(b.name.length<2||b.name.length>80||!/^\+?[0-9\s-]{9,18}$/.test(b.phone)||!validDay(b.day)||min(b.start)===null||![30,60,90,120].includes(b.duration)||b.notes.length>400)return res.status(400).json({error:'بيانات الموعد غير صحيحة'});try{const id=insertBooking(b);if(person)db.prepare('UPDATE bookings SET patient_id=? WHERE id=?').run(person.id,id);res.status(201).json({id})}catch(e){res.status(409).json({error:'يوجد موعد يتعارض مع الفترة المحددة'})}});
app.patch('/api/admin/bookings/:id',auth,receptionOnly,(req,res)=>{const status=safe(req.body.status);if(!['pending','confirmed','cancelled'].includes(status))return res.status(400).json({error:'حالة غير صحيحة'});const result=db.prepare('UPDATE bookings SET status=? WHERE id=?').run(status,Number(req.params.id));res.json({updated:result.changes})});

const numericId=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
app.get('/api/admin/patients',auth,(req,res)=>{const q=safe(req.query.q);if(!q)return res.json([]);if(q.length>80)return res.status(400).json({error:'بحث طويل جداً'});const term='%'+q.replace(/[%_]/g,'')+'%';res.json(db.prepare(`SELECT * FROM patients WHERE CAST(id AS TEXT)=? OR phone LIKE ? OR national_id LIKE ? ORDER BY id DESC LIMIT 40`).all(q,term,term))});
app.post('/api/admin/patients',auth,(req,res)=>{const full_name=safe(req.body.full_name),phone=safe(req.body.phone),national_id=safe(req.body.national_id),nationality=safe(req.body.nationality),gender=safe(req.body.gender),age=req.body.age===''||req.body.age==null?null:Number(req.body.age);if(full_name.length<3||full_name.length>120||!/^05[0-9]{8}$/.test(phone)||!/^\d{10}$/.test(national_id)||nationality.length>50||!['male','female'].includes(gender)||(age!==null&&(!Number.isInteger(age)||age<0||age>120)))return res.status(400).json({error:'بيانات الملف غير صحيحة'});const existing=db.prepare('SELECT id FROM patients WHERE national_id=?').get(national_id);
if(existing)return res.status(409).json({error:'رقم الهوية مسجل مسبقًا في ملف المريض رقم '+existing.id+'. ابحثي عنه وافتحي الملف الموجود بدل إنشاء ملف جديد.',existing_file_number:existing.id});
try{const r=db.prepare('INSERT INTO patients(full_name,phone,national_id,age,nationality,gender) VALUES(?,?,?,?,?,?)').run(full_name,phone,national_id,age,nationality,gender);res.status(201).json({id:Number(r.lastInsertRowid)})}catch(e){if(e.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'رقم الهوية مسجل مسبقًا. ابحثي عنه في ملفات المرضى.'});console.error('Patient create failed',e.code);res.status(500).json({error:'تعذر حفظ الملف. حاولي مرة أخرى'})}});
app.get('/api/admin/patients/:id',auth,(req,res)=>{const id=numericId(req.params.id);if(!id)return res.sendStatus(400);const patient=db.prepare('SELECT * FROM patients WHERE id=?').get(id);if(!patient)return res.sendStatus(404);res.json({patient,appointments:db.prepare('SELECT * FROM bookings WHERE patient_id=? ORDER BY day DESC,start DESC LIMIT 100').all(id),plans:db.prepare(`SELECT t.*,COALESCE((SELECT SUM(amount) FROM payments WHERE plan_id=t.id),0) AS paid FROM treatment_plans t WHERE t.patient_id=? ORDER BY id DESC`).all(id)})});
app.get('/api/admin/calendar',auth,(req,res)=>{const from=safe(req.query.from),to=safe(req.query.to);if(!validDay(from)||!validDay(to)||to<from||((Date.parse(to)-Date.parse(from))/864e5)>40)return res.status(400).json({error:'فترة غير صحيحة'});res.json(db.prepare("SELECT b.*,p.id AS file_number FROM bookings b LEFT JOIN patients p ON p.id=b.patient_id WHERE day BETWEEN ? AND ? AND b.status != 'cancelled' ORDER BY day,start,id").all(from,to))});
app.patch('/api/admin/bookings/:id/visit-status',auth,(req,res)=>{const id=numericId(req.params.id),next=safe(req.body.visit_status);if(!id||!['scheduled','arrived','in_chair','completed','no_show'].includes(next))return res.status(400).json({error:'حالة غير صحيحة'});if(req.session.role==='doctor'&&next!=='completed')return res.status(403).json({error:'حساب الدكتور يمكنه تغيير الحالة إلى مكتمل فقط'});const old=db.prepare('SELECT visit_status FROM bookings WHERE id=?').get(id);if(!old)return res.sendStatus(404);const tx=db.transaction(()=>{db.prepare('UPDATE bookings SET visit_status=? WHERE id=?').run(next,id);db.prepare('INSERT INTO appointment_audit(booking_id,role,old_status,new_status) VALUES(?,?,?,?)').run(id,req.session.role,old.visit_status,next)});tx.immediate();res.json({updated:1})});


const money=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=10000000&&Math.round(n*100)===n*100;
app.post('/api/admin/patients/:id/plans',auth,(req,res)=>{const id=numericId(req.params.id),p=db.prepare('SELECT id FROM patients WHERE id=?').get(id||0),title=safe(req.body.title),details=safe(req.body.details),total=Number(req.body.total_cost);if(!p||title.length<2||title.length>150||details.length>3000||!money(total))return res.status(400).json({error:'بيانات الخطة العلاجية غير صحيحة'});const r=db.prepare('INSERT INTO treatment_plans(patient_id,title,details,total_cost) VALUES(?,?,?,?)').run(id,title,details,total);res.status(201).json({id:Number(r.lastInsertRowid)})});
app.post('/api/admin/plans/:id/payments',auth,receptionOnly,(req,res)=>{const id=numericId(req.params.id),plan=db.prepare('SELECT id,total_cost FROM treatment_plans WHERE id=?').get(id||0),amount=Number(req.body.amount),note=safe(req.body.note);if(!plan||!money(amount)||amount<=0||note.length>200)return res.status(400).json({error:'بيانات الدفعة غير صحيحة'});const paid=db.prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE plan_id=?').get(id).paid;if(Math.round((paid+amount)*100)>Math.round(plan.total_cost*100))return res.status(409).json({error:'المبلغ يتجاوز المتبقي من الخطة'});const r=db.prepare('INSERT INTO payments(plan_id,amount,note) VALUES(?,?,?)').run(id,amount,note);res.status(201).json({id:Number(r.lastInsertRowid)})});
app.get('/api/admin/patients/:id/dental',auth,(req,res)=>{
 const id=numericId(req.params.id);
 if(!id||!db.prepare('SELECT id FROM patients WHERE id=?').get(id))return res.status(404).json({error:'ملف المريض غير موجود'});
 const teeth=db.prepare(`SELECT d.id,d.tooth_code,d.procedure_type,d.description,d.created_at,d.created_by,
 t.id AS plan_id,t.total_cost,COALESCE((SELECT SUM(amount) FROM payments WHERE plan_id=t.id),0) AS paid
 FROM dental_procedures d JOIN treatment_plans t ON t.id=d.plan_id WHERE d.patient_id=? ORDER BY d.created_at DESC,d.id DESC`).all(id);
 res.json({teeth});
});
app.post('/api/admin/patients/:id/dental',auth,(req,res)=>{
 const id=numericId(req.params.id),tooth=Number(req.body.tooth_code),type=safe(req.body.procedure_type),description=safe(req.body.description),cost=Number(req.body.total_cost);
 if(!id||!db.prepare('SELECT id FROM patients WHERE id=?').get(id))return res.status(404).json({error:'ملف المريض غير موجود'});
 if(!validTooth(tooth)||!dentalTypes.includes(type)||description.length>2000||!money(cost))return res.status(400).json({error:'تأكدي من السن ونوع العلاج والتكلفة'});
 try{
  const result=db.transaction(()=>{
   const p=db.prepare('INSERT INTO treatment_plans(patient_id,title,details,total_cost) VALUES(?,?,?,?)').run(id,'السن '+tooth+' — '+type,description,cost);
   const d=db.prepare('INSERT INTO dental_procedures(patient_id,tooth_code,procedure_type,description,plan_id,created_by) VALUES(?,?,?,?,?,?)').run(id,tooth,type,description,p.lastInsertRowid,req.session.role);
   return {id:Number(d.lastInsertRowid),plan_id:Number(p.lastInsertRowid)};
  }).immediate();
  res.status(201).json(result);
 }catch(err){console.error('Dental procedure create:',err.code||err.message);res.status(500).json({error:'تعذر تسجيل علاج السن'})}
});
app.get('/api/admin/cancelled',auth,(req,res)=>{const day=safe(req.query.day);if(!validDay(day))return res.status(400).json({error:'تاريخ غير صحيح'});res.json(db.prepare("SELECT * FROM bookings WHERE day=? AND status='cancelled' ORDER BY start,id").all(day))});

// Invoices use integer cents to avoid floating point rounding issues.
app.get('/api/admin/invoices',auth,receptionOnly,(req,res)=>{const rows=db.prepare('SELECT i.id,i.patient_id,p.full_name,i.description,i.amount_cents,i.payment_status,i.created_at FROM invoices i JOIN patients p ON p.id=i.patient_id ORDER BY i.id DESC LIMIT 300').all();res.json(rows.map(({amount_cents,...r})=>({...r,amount:amount_cents/100}))) });
app.post('/api/admin/invoices',auth,receptionOnly,(req,res)=>{const id=numericId(req.body.patient_id),description=safe(req.body.description),amount=Number(req.body.amount),status=safe(req.body.payment_status);if(!id||!db.prepare('SELECT id FROM patients WHERE id=?').get(id)||description.length<2||description.length>200||!Number.isFinite(amount)||amount<=0||amount>10000000||Math.abs(amount*100-Math.round(amount*100))>0.000001||!['paid','unpaid'].includes(status))return res.status(400).json({error:'بيانات الفاتورة غير صحيحة'});const r=db.prepare('INSERT INTO invoices(patient_id,description,amount_cents,payment_status) VALUES(?,?,?,?)').run(id,description,Math.round(amount*100),status);res.status(201).json({id:Number(r.lastInsertRowid)})});
app.patch('/api/admin/invoices/:id/pay',auth,receptionOnly,(req,res)=>{const id=numericId(req.params.id);if(!id)return res.sendStatus(400);const r=db.prepare("UPDATE invoices SET payment_status='paid' WHERE id=? AND payment_status='unpaid'").run(id);res.json({updated:r.changes})});

// Existing treatment-plan payments are also a financial action.
// Assistant replies can run in two modes:
// 1) Generative mode through OpenAI-compatible Responses API when OPENAI_API_KEY is configured.
// 2) Fast fallback guidance mode when no API key is present or the provider is unavailable.
const chatLimit=rateLimit({windowMs:15*60*1000,limit:35,standardHeaders:'draft-7',legacyHeaders:false});
const guidance={
 ar:{urgent:'إذا كان لديك صعوبة في التنفس أو البلع، نزيف لا يتوقف، أو تورّم سريع في الوجه، اطلب رعاية طبية عاجلة فورًا. لا تنتظر الرد من الموقع.',price:'أسعار الخدمات غير مضافة أو معتمدة في النسخة الحالية. تواصل مع الاستقبال للحصول على عرض سعر بعد التقييم.',clean:'بعد تنظيف الجير: قد تشعر بحساسية بسيطة أو نزف خفيف مؤقت. استخدم فرشاة ناعمة بلطف وخيط الأسنان بحسب تعليمات طبيبك، وتجنب الأطعمة المزعجة للثة. راجع الطبيب إذا استمر الألم أو النزيف.',root:'بعد علاج العصب: تجنب المضغ على السن المعالج حتى يزول التخدير، والتزم بموعد الحشوة أو التاج النهائي. قد يحدث انزعاج بسيط. راجع الطبيب عند ألم شديد متزايد أو تورم.',implant:'بعد زراعة الأسنان: اتبع تعليمات الجرّاح بدقة، ولا تلمس منطقة الزراعة أو تدخن. تناول طعامًا طريًا في البداية حسب إرشاد الطبيب، واطلب تقييمًا عند نزيف مستمر أو تورّم متزايد.',brush:'للعناية اليومية: فرشاة ناعمة مرتين يوميًا بمعجون فلورايد، ونظّف ما بين الأسنان يوميًا بالخيط أو الفرشاة البينية. جهاز تنظيف الأسنان بالماء يمكن أن يكون مكمّلًا، لا بديلًا تلقائيًا عن جميع وسائل التنظيف.',symptom:'لا يمكن تشخيص الحالة من الأعراض وحدها. صف الألم وموعد بدايته عمومًا، واحجز فحصًا لدى طبيب الأسنان لتحديد السبب والخطة المناسبة.',default:'أقدر أقدم إرشادات عامة عن الفرشاة والمعجون والخيط المائي، العناية بعد تنظيف الجير، علاج العصب أو الزراعة، الحجز، وأسباب بعض الأعراض المحتملة. للتشخيص أو تحديد التكلفة النهائية يلزم تقييم طبيب الأسنان.'},
 en:{urgent:'If you have difficulty breathing or swallowing, uncontrolled bleeding, or rapidly increasing facial swelling, seek urgent medical care now.',price:'Service prices have not been verified or configured. Ask reception for a quote after clinical assessment.',clean:'After scaling: temporary gum sensitivity or mild bleeding can occur. Brush gently with a soft brush and follow your dentist’s flossing advice. Seek care for ongoing bleeding or worsening pain.',root:'After a root canal: avoid chewing until numbness wears off, and complete the recommended final restoration. Contact your dentist for severe or increasing pain or swelling.',implant:'After implant surgery: follow the surgeon’s instructions, avoid smoking and disturbing the area, and use a soft diet as directed. Seek care for persistent bleeding or worsening swelling.',brush:'Brush twice daily with fluoride toothpaste and a soft brush. Clean between teeth daily with floss or interdental brushes. A water flosser can be an additional tool.',symptom:'Symptoms alone are not enough for a reliable diagnosis. Please book a dental examination to identify the cause and appropriate treatment.',default:'I can share general information about oral hygiene, scaling, root canal aftercare, implants, booking, and possible reasons behind some symptoms. A dentist must diagnose conditions and confirm treatment prices.'}
};
const symptomGuidance={
 ar:{cold:'ألم الأسنان مع البارد قد يرتبط بحساسية الأسنان، انحسار اللثة، تسوس أو شق في السن. إذا استمر الألم بعد زوال البارد أو جاء تلقائيًا فقد يحتاج السن إلى فحص عاجل. هل يستمر الألم لثوانٍ أم لدقائق؟ وهل هو في سن واحد؟ ينصح بالفحص لتحديد السبب، ولا يمكن الجزم بالتشخيص عن بُعد.',gum:'نزيف اللثة عند التفريش قد ينجم عن التهاب اللثة وتراكم البلاك، وأحيانًا عن تفريش قوي. استعمل فرشاة ناعمة ونظف بين الأسنان بلطف، واحجز فحص لثة وتنظيفًا عند الحاجة. إذا كان النزيف شديدًا أو لا يتوقف فاطلب مساعدة طبية.',breath:'رائحة الفم قد ترتبط بتراكم البلاك على الأسنان واللسان، مشاكل اللثة، جفاف الفم أو أسباب أخرى. نظّف الأسنان واللسان وبين الأسنان واشرب الماء. إذا استمرت، احجز فحص الأسنان واللثة لتحديد السبب.',cavity:'التسوس قد يظهر كحساسية للسكر أو البارد، ألم عند المضغ أو بقع وتجاويف، وقد يكون بلا أعراض. يحتاج تأكيده إلى فحص طبيب الأسنان وقد يلزم تصوير. العلاج يعتمد على حجم التسوس ولا يمكن تحديده من الرسالة وحدها.',abscess:'قد يدل ألم نابض مع تورم أو طعم سيئ على عدوى سنية تحتاج تقييم طبيب الأسنان سريعًا. إذا ظهر تورم منتشر أو حمى أو صعوبة بلع أو تنفس فاذهب للطوارئ. لا تبدأ مضادًا حيويًا دون تقييم سريري.',wisdom:'ألم ضرس العقل قد ينجم عن التهاب اللثة المحيطة أو التسوس أو الضغط على الأسنان المجاورة. يحتاج تقييمًا سريريًا وصورة أشعة حسب الحاجة. إذا ظهر تورم متزايد أو صعوبة فتح الفم أو البلع فاطلب رعاية عاجلة.',broken:'السن المكسور قد يحتاج تنعيم حافة أو ترميمًا أو علاجًا أعمق حسب وصول الكسر للعصب. تجنب المضغ على السن واحتفظ بالجزء المكسور إن وجد واحجز تقييمًا سريعًا.',dry:'جفاف الفم قد يرتبط بقلة السوائل أو التنفس من الفم أو بعض الأدوية وغيرها. اشرب الماء بانتظام واستخدم علكة خالية من السكر إذا كانت مناسبة لك. راجع طبيب الأسنان عند استمرار المشكلة.'},
 en:{cold:'Sensitivity to cold can be related to exposed dentin, gum recession, decay, or a crack. Lingering or spontaneous pain needs prompt dental evaluation. Does the pain last seconds or minutes, and is it one tooth? This is not a diagnosis.',gum:'Bleeding gums may be related to plaque-induced gingivitis or hard brushing. Brush gently with a soft brush and clean between teeth. Schedule a dental exam; persistent or heavy bleeding warrants prompt medical advice.',breath:'Bad breath may have several causes, including oral plaque, gum disease or dry mouth. Brush teeth and tongue, clean between teeth and hydrate. Persistent symptoms need a dental exam.',cavity:'Cavities can cause sensitivity or chewing pain but may have no symptoms. A dentist needs to examine the teeth, sometimes with radiographs, to confirm.',abscess:'Throbbing pain with swelling or a bad taste can indicate a dental infection and needs prompt assessment. Seek urgent care for spreading swelling, fever, trouble swallowing or breathing.',wisdom:'Wisdom tooth pain may be due to inflammation around the tooth or decay. Book a dental assessment. Increasing swelling or trouble opening your mouth needs urgent care.',broken:'A broken tooth needs prompt dental assessment. Avoid chewing on it and save any detached fragment.',dry:'Dry mouth can relate to hydration, mouth breathing or medications. Sip water regularly and seek advice if it persists.'}
};
function inferSymptom(message){
 const q=message.toLowerCase();
 if(/صعوبة (التنفس|البلع)|ضيق تنفس|نزيف (شديد|مستمر)|تورم (شديد|سريع)|difficulty breathing|difficulty swallowing|uncontrolled bleeding|rapid swelling/.test(q))return 'urgent';
 if(/بارد|بارده|باردة|cold|حساس(ية)?/.test(q))return 'cold';
 if(/لث[ةتي]|نزيف اللث|gum|gingiv/.test(q))return 'gum';
 if(/رائح|ريحة|نفس كريه|bad breath|halitosis/.test(q))return 'breath';
 if(/خراج|صديد|قيح|abscess|pus/.test(q))return 'abscess';
 if(/ضرس العقل|wisdom/.test(q))return 'wisdom';
 if(/مكسور|انكسر|كسر السن|broken tooth|cracked tooth/.test(q))return 'broken';
 if(/جفاف|dry mouth/.test(q))return 'dry';
 if(/تسوس|cavit|decay/.test(q))return 'cavity';
 return null;
}
function fallbackAnswer(msg,lang){
 const q=msg.toLowerCase();
 const symptom=inferSymptom(q);
 if(symptom&&symptom!=='urgent')return {answer:symptomGuidance[lang][symptom],mode:'fallback-symptom'};
 let key='default';
 if(/breath|swallow|uncontroll|تورم شديد|ضيق تنفس|صعوبة (التنفس|البلع)|نزيف شديد/.test(q))key='urgent';
 else if(/price|cost|fee|سعر|أسعار|تكلف|كم ريال/.test(q))key='price';
 else if(/implant|زراع/.test(q))key='implant';
 else if(/root canal|nerve|عصب/.test(q))key='root';
 else if(/scaling|cleaning|tartar|جير|تنظيف/.test(q))key='clean';
 else if(/brush|toothpaste|floss|water flosser|فرش|معجون|خيط|صحة الفم/.test(q))key='brush';
 else if(/pain|toothache|bleed|swelling|وجع|ألم|نزف|انتفاخ|تورم|تسوس/.test(q))key='symptom';
 return {answer:guidance[lang][key],mode:'fallback-guidance'};
}
const aiEnabled=!!process.env.OPENAI_API_KEY;
const aiModel=process.env.OPENAI_MODEL||'gpt-4.1-mini';
const aiBase=(process.env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
function buildSystemPrompt(lang){
 return lang==='ar'
 ? `أنت مساعد افتراضي لعيادة أسنان اسمها DentalCare Pro. أجب بالعربية الواضحة والمطمئنة. قدم معلومات أولية عامة عن أعراض الأسنان والعناية الفموية والخدمات والحجز، وكن موجزًا ومنظمًا. لا تقدّم تشخيصًا نهائيًا، ولا تصف دواءً أو جرعات علاجية، ولا تطلب أو تعالج ملفات مرضى كاملة. إذا ظهرت مؤشرات خطورة مثل صعوبة التنفس أو البلع أو نزيف شديد أو تورم منتشر، وجّه المستخدم للرعاية العاجلة فورًا. إذا سأل عن السعر فاذكر أن السعر النهائي يحتاج تقييم العيادة. اختم عند اللزوم بتنبيه مختصر أن المعلومات أولية ولا تغني عن الفحص.`
 : `You are a virtual assistant for a dental clinic called DentalCare Pro. Reply in clear, warm English. Provide general preliminary information about dental symptoms, oral care, services, and booking. Be concise and structured. Do not provide a definitive diagnosis, prescribe medication, or process full patient records. If the user mentions danger signs like difficulty breathing/swallowing, uncontrolled bleeding, or spreading swelling, direct them to urgent care immediately. If asked about prices, explain that final pricing needs clinical assessment. When appropriate, include a brief note that the information is preliminary and not a diagnosis.`;
}
async function generateOpenAIAnswer(msg,lang){
 const response=await fetch(`${aiBase}/responses`,{
   method:'POST',
   headers:{
     'Content-Type':'application/json',
     'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`
   },
   body:JSON.stringify({
     model:aiModel,
     input:[
       {role:'system',content:[{type:'input_text',text:buildSystemPrompt(lang)}]},
       {role:'user',content:[{type:'input_text',text:msg}]}
     ],
     max_output_tokens:320,
     temperature:0.5
   })
 });
 if(!response.ok){
   const errText=await response.text();
   throw new Error(`AI_${response.status}:${errText.slice(0,200)}`);
 }
 const data=await response.json();
 let answer='';
 if(typeof data.output_text==='string'&&data.output_text.trim())answer=data.output_text.trim();
 else if(Array.isArray(data.output)){
   for(const item of data.output){
     if(Array.isArray(item.content)){
       for(const part of item.content){
         if(typeof part.text==='string')answer+=part.text;
       }
     }
   }
   answer=answer.trim();
 }
 if(!answer)throw new Error('AI_EMPTY');
 return answer;
}
app.post('/api/chat',chatLimit,async(req,res)=>{
 const msg=safe(req.body.message).slice(0,500);
 const lang=req.body.lang==='en'?'en':'ar';
 if(!msg)return res.status(400).json({error:lang==='en'?'Enter a message':'أدخل رسالة'});
 try{
   const emergency=inferSymptom(msg);
   if(emergency==='urgent'){
     return res.json({answer:guidance[lang].urgent,mode:'urgent-fallback'});
   }
   if(aiEnabled){
     const answer=await generateOpenAIAnswer(msg,lang);
     return res.json({answer,mode:'generative'});
   }
 }catch(err){
   console.error('AI chat fallback:',err.message);
 }
 const fallback=fallbackAnswer(msg,lang);
 res.json({answer:fallback.answer,mode:fallback.mode});
});

app.listen(process.env.PORT||3000,()=>console.log('DentalCare Pro V9 running on http://localhost:'+(process.env.PORT||3000)));
