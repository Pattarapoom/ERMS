/* ============================================================
   data.js — ข้อมูลตั้งต้น / Configuration ระบบจัดตารางเวรพยาบาล
   ============================================================ */

// ──────────────────── 1) โควต้าจำนวนคนต่อเวร ────────────────────
const SHIFT_QUOTA = { M: 16, A: 15, N: 10 };

// ──────────────────── 2) บทบาทขั้นต่ำที่ต้องมี ────────────────────
const ROLE_MINIMUMS = {
    M: [
        { role: 'Head', count: 3 },
        { role: 'Incharge1', count: 1 },
        { role: 'Incharge_team', count: 2 },
        { role: 'Fast_track', count: 1 },
        { role: 'Triage', count: 1 },
        { role: 'Med', count: 3 },
        { role: 'Inc_proc', count: 1 },   // Inc หัตถการ
        { role: 'Med_proc', count: 1 },   // Inc Trauma
        { role: 'Screen_center', count: 2 },   // คัดกรองกลาง
        { role: 'Inc_screen_center', count: 0 },   // Inc คัดกรองกลาง (ปรับจำนวนได้)
        { role: 'Screen_6_8', count: 1 },   // คัดกรอง 6-8
    ],
    A: [
        { role: 'Incharge1', count: 1 },
        { role: 'Incharge_team', count: 2 },
        { role: 'Fast_track', count: 1 },
        { role: 'Triage', count: 1 },
        { role: 'Med', count: 5 },
        { role: 'Proc_16_20', count: 1 },   // หัตถการ 16-20
    ],
    N: [
        { role: 'Incharge1', count: 1 },
        { role: 'Incharge_team', count: 1 },
        { role: 'Triage', count: 1 },
        { role: 'Med', count: 2 },
    ],
};

// ──────────────────── 3) กฎห้ามลงเวร (ข้ามวัน) ────────────────────
const FORBIDDEN_TRANSITIONS = [
    { prev: 'N', next: 'M' },  // ดึก→เช้า
    { prev: 'A', next: 'M' },  // บ่าย→เช้า
    { prev: 'A', next: 'N' },  // บ่าย→ดึก
];

// ──────────────────── 4) วันละ 1 เวร & เช้า-บ่ายติดยาว ────────────────────
const MAX_CONSECUTIVE_MA = 3; // ห้ามเกิน 3 วันติดเช้า/บ่าย

// ──────────────────── 5) ข้อจำกัดตาม headCode ────────────────────
// headCode 9: เช้าเท่านั้น
// headCode 8: เช้าเท่านั้น, Incharge1/Incharge_team เฉพาะ สส.
// headCode 7: ห้ามดึก, บ่ายเฉพาะวันธรรมดา

// ──────────────────── 6) บทบาทที่เช้าเท่านั้น ────────────────────
const MORNING_ONLY_ROLES = ['Screen_center', 'Inc_screen_center', 'Screen_6_8', 'Inc_proc', 'Med_proc'];

// ──────────────────── Role labels (Thai) ────────────────────
const ROLE_LABELS = {
    Head: 'Head',
    Incharge1: 'Incharge 1',
    Incharge_team: 'Incharge Team',
    Fast_track: 'Fast Track',
    Triage: 'Triage',
    Med: 'Med',
    Inc_proc: 'Inc หัตถการ',
    Med_proc: 'Inc Trauma',
    Screen_center: 'คัดกรองกลาง',
    Inc_screen_center: 'Inc คัดกรองกลาง',
    Screen_6_8: 'คัดกรอง 6-8',
    Proc_16_20: 'หัตถการ 16-20',
    Screen_16_20: 'คัดกรอง 16-20',
};

// ──────────────────── Shift labels (Thai) ────────────────────
const SHIFT_LABELS = { M: 'เช้า (M)', A: 'บ่าย (A)', N: 'ดึก (N)' };
const SHIFT_COLORS = {
    M: { bg: '#fef3c7', border: '#f59e0b', text: '#92400e', badge: '#f59e0b' },
    A: { bg: '#dbeafe', border: '#3b82f6', text: '#1e3a5a', badge: '#3b82f6' },
    N: { bg: '#ede9fe', border: '#8b5cf6', text: '#3b0764', badge: '#8b5cf6' },
};

// ──────────────────── Leave Types ────────────────────
const LEAVE_TYPES = {
    off: { label: 'ขอหยุด', color: '#64748b', icon: '⏸️' },
    personal: { label: 'ลากิจ', color: '#f97316', icon: '📋' },
    sick: { label: 'ลาป่วย', color: '#ef4444', icon: '🤒' },
    vacation: { label: 'ลาพักผ่อน', color: '#22c55e', icon: '🌴' },
    training: { label: 'ลาอบรม', color: '#3b82f6', icon: '📚' },
    preceptor: { label: 'Preceptor', color: '#a855f7', icon: '🎓' },
    education: { label: 'ลาศึกษา', color: '#06b6d4', icon: '🏫' },
    religious: { label: 'ลาประกอบพิธีทางศาสนา', color: '#8b5cf6', icon: '🙏' },
    military: { label: 'ลาเข้ารับการเตรียมพล', color: '#475569', icon: '🪖' },
    maternity: { label: 'ลาคลอด', color: '#ec4899', icon: '🍼' },
    paternity: { label: 'ลาไปช่วยเหลือภริยาที่คลอดบุตร', color: '#14b8a6', icon: '👶' },
    sterilization: { label: 'ลาทำหมัน', color: '#f59e0b', icon: '🏥' },
};

// ──────────────────── Leave Limits by Level ────────────────────
// Max simultaneous off/leave per level
const LEAVE_LIMITS_BY_LEVEL = {
    1: 3,
    2: 2,
    3: 2,
    4: 2
};

// ──────────────────── Sample Nurses (Demo Data) ────────────────────
// ✅ ใช้ข้อมูลสมมติสำหรับ public repository
// 📝 สำหรับข้อมูลจริง ดูที่ nurses-real.js (ไม่ upload ขึ้น Git)
const SAMPLE_NURSES = [
    {
        "id": "N001",
        "name": "Head Nurse A",
        "headCode": 9,
        "roles": ["Head", "Med"],
        "level": 3
    },
    {
        "id": "N002",
        "name": "Head Nurse B",
        "headCode": 9,
        "roles": ["Head", "Med"],
        "level": 3
    },
    {
        "id": "N003",
        "name": "Head Nurse C",
        "headCode": 9,
        "roles": ["Head", "Med"],
        "level": 3
    },
    {
        "id": "N004",
        "name": "Head Nurse D",
        "headCode": 9,
        "roles": ["Head", "Med"],
        "level": 3
    },
    {
        "id": "N005",
        "name": "Incharge Nurse 1",
        "headCode": 5,
        "roles": ["Incharge1", "Incharge_team", "Med"],
        "level": 3
    },
    {
        "id": "N006",
        "name": "Incharge Nurse 2",
        "headCode": 5,
        "roles": ["Incharge1", "Incharge_team", "Med"],
        "level": 3
    },
    {
        "id": "N007",
        "name": "Incharge Nurse 3",
        "headCode": 5,
        "roles": ["Incharge1", "Incharge_team", "Med"],
        "level": 3
    },
    {
        "id": "N008",
        "name": "Incharge Nurse 4",
        "headCode": 5,
        "roles": ["Incharge1", "Incharge_team", "Med"],
        "level": 3
    },
    {
        "id": "N009",
        "name": "Team Lead 1",
        "headCode": 5,
        "roles": ["Incharge1", "Incharge_team", "Med"],
        "level": 3
    },
    {
        "id": "N010",
        "name": "Senior Nurse 1",
        "headCode": 5,
        "roles": ["Incharge_team", "Med"],
        "level": 2
    },
    {
        "id": "N011",
        "name": "Senior Nurse 2",
        "headCode": 5,
        "roles": ["Incharge_team", "Med"],
        "level": 2
    },
    {
        "id": "N012",
        "name": "Senior Nurse 3",
        "headCode": 5,
        "roles": ["Incharge_team", "Med"],
        "level": 2
    },
    {
        "id": "N013",
        "name": "Senior Nurse 4",
        "headCode": 5,
        "roles": ["Incharge_team", "Med"],
        "level": 2
    },
    {
        "id": "N014",
        "name": "Senior Nurse 5",
        "headCode": 5,
        "roles": ["Incharge_team", "Med"],
        "level": 2
    },
    {
        "id": "N015",
        "name": "Fast Track Specialist 1",
        "headCode": 5,
        "roles": ["Fast_track", "Triage", "Med"],
        "level": 2
    },
    {
        "id": "N016",
        "name": "Fast Track Specialist 2",
        "headCode": 5,
        "roles": ["Fast_track", "Triage", "Med"],
        "level": 2
    },
    {
        "id": "N017",
        "name": "Triage Nurse 1",
        "headCode": 5,
        "roles": ["Fast_track", "Triage", "Med"],
        "level": 2
    },
    {
        "id": "N018",
        "name": "Triage Nurse 2",
        "headCode": 5,
        "roles": ["Fast_track", "Triage", "Med"],
        "level": 2
    },
    {
        "id": "N019",
        "name": "Procedure Nurse 1",
        "headCode": 5,
        "roles": ["Inc_proc", "Med_proc", "Screen_6_8", "Med"],
        "level": 2
    },
    {
        "id": "N020",
        "name": "Procedure Nurse 2",
        "headCode": 5,
        "roles": ["Inc_proc", "Med_proc", "Screen_6_8", "Med"],
        "level": 2
    },
    {
        "id": "N021",
        "name": "Procedure Nurse 3",
        "headCode": 5,
        "roles": ["Inc_proc", "Med_proc", "Screen_6_8", "Med"],
        "level": 2
    },
    {
        "id": "N022",
        "name": "Screening Center 1",
        "headCode": 5,
        "roles": ["Screen_center", "Inc_screen_center", "Med"],
        "level": 1
    },
    {
        "id": "N023",
        "name": "Screening Center 2",
        "headCode": 5,
        "roles": ["Screen_center", "Inc_screen_center", "Med"],
        "level": 1
    },
    {
        "id": "N024",
        "name": "Screening Center 3",
        "headCode": 5,
        "roles": ["Screen_center", "Inc_screen_center", "Med"],
        "level": 1
    },
    {
        "id": "N025",
        "name": "Screening Center 4",
        "headCode": 5,
        "roles": ["Screen_center", "Inc_screen_center", "Med"],
        "level": 1
    },
    {
        "id": "N026",
        "name": "Screening Center 5",
        "headCode": 5,
        "roles": ["Screen_center", "Inc_screen_center", "Med"],
        "level": 1
    },
    {
        "id": "N027",
        "name": "Afternoon Specialist 1",
        "headCode": 5,
        "roles": ["Proc_16_20", "Screen_16_20", "Med"],
        "level": 1
    },
    {
        "id": "N028",
        "name": "Afternoon Specialist 2",
        "headCode": 5,
        "roles": ["Proc_16_20", "Screen_16_20", "Med"],
        "level": 1
    },
    {
        "id": "N029",
        "name": "Afternoon Specialist 3",
        "headCode": 5,
        "roles": ["Proc_16_20", "Screen_16_20", "Med"],
        "level": 1
    },
    {
        "id": "N030",
        "name": "Afternoon Specialist 4",
        "headCode": 5,
        "roles": ["Proc_16_20", "Screen_16_20", "Med"],
        "level": 1
    },
    {
        "id": "N031",
        "name": "Medical Nurse 1",
        "headCode": 5,
        "roles": ["Med"],
        "level": 1
    },
    {
        "id": "N032",
        "name": "Medical Nurse 2",
        "headCode": 5,
        "roles": ["Med"],
        "level": 1
    },
    {
        "id": "N033",
        "name": "Medical Nurse 3",
        "headCode": 5,
        "roles": ["Med"],
        "level": 1
    },
    {
        "id": "N034",
        "name": "Medical Nurse 4",
        "headCode": 5,
        "roles": ["Med"],
        "level": 1
    },
    {
        "id": "N035",
        "name": "Medical Nurse 5",
        "headCode": 5,
        "roles": ["Med"],
        "level": 1
    },
    {
        "id": "N036",
        "name": "Medical Nurse 6",
        "headCode": 5,
        "roles": ["Med"],
        "level": 1
    },
    {
        "id": "N037",
        "name": "Medical Nurse 7",
        "headCode": 5,
        "roles": ["Med"],
        "level": 1
    },
    {
        "id": "N038",
        "name": "Multi-Role Nurse",
        "headCode": 5,
        "roles": ["Med", "Screen_6_8", "Screen_16_20"],
        "level": 1
    }
];

// ──────────────────── Admin Password ────────────────────
const ADMIN_PASSWORD = 'admin1234';
