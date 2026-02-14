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
        { role: 'Med_proc', count: 1 },   // Med หัตถการ
        { role: 'Screen_center', count: 2 },   // คัดกรองกลาง
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
const MORNING_ONLY_ROLES = ['Screen_center', 'Screen_6_8', 'Inc_proc', 'Med_proc'];

// ──────────────────── Role labels (Thai) ────────────────────
const ROLE_LABELS = {
    Head: 'Head',
    Incharge1: 'Incharge 1',
    Incharge_team: 'Incharge Team',
    Fast_track: 'Fast Track',
    Triage: 'Triage',
    Med: 'Med',
    Inc_proc: 'Inc หัตถการ',
    Med_proc: 'Med หัตถการ',
    Screen_center: 'คัดกรองกลาง',
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
    sick: { label: 'ลาป่วย', color: '#ef4444', icon: '🤒' },
    personal: { label: 'ลากิจ', color: '#f97316', icon: '📋' },
    vacation: { label: 'ลาพักผ่อน', color: '#22c55e', icon: '🌴' },
    training: { label: 'ลาอบรม', color: '#3b82f6', icon: '📚' },
};

// ──────────────────── Imported Nurses (Manual Fix) ────────────────────
const SAMPLE_NURSES = [
    {
        "id": "N001",
        "name": "พว. จาตุรง พิมโคตร",
        "headCode": 9,
        "roles": [
            "Head",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N002",
        "name": "พว. อารียา บุญพระ",
        "headCode": 9,
        "roles": [
            "Head",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N003",
        "name": "พว. พีรยา บัวขาว",
        "headCode": 9,
        "roles": [
            "Head",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N004",
        "name": "พว. สุจิตรา ลำมะนา",
        "headCode": 9,
        "roles": [
            "Head",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N005",
        "name": "พว. ผกาวรรณ ไชยธรรม",
        "headCode": 5,
        "roles": [
            "Incharge1",
            "Incharge_team",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N006",
        "name": "พว. ณัฐธิชา หาญเชิงชัย",
        "headCode": 5,
        "roles": [
            "Incharge1",
            "Incharge_team",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N007",
        "name": "พว. มัฌติกา ทองแก้ว",
        "headCode": 5,
        "roles": [
            "Incharge1",
            "Incharge_team",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N008",
        "name": "พว. อมรรัตน์ จันทคาม",
        "headCode": 5,
        "roles": [
            "Incharge1",
            "Incharge_team",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N009",
        "name": "พว. วรรณทิวา เผ่ามณี",
        "headCode": 5,
        "roles": [
            "Incharge1",
            "Incharge_team",
            "Med"
        ],
        "level": 3
    },
    {
        "id": "N010",
        "name": "พว. ช่อลัดดา ชำนาญพล",
        "headCode": 5,
        "roles": [
            "Incharge_team",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N011",
        "name": "พว. ศิริลักษณ์ เพ็งอินทร์",
        "headCode": 5,
        "roles": [
            "Incharge_team",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N012",
        "name": "พว. ทัศณีย์ แซ่เจีย",
        "headCode": 5,
        "roles": [
            "Incharge_team",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N013",
        "name": "พว. สุดารัตน์ สร้อยสังวาลย์",
        "headCode": 5,
        "roles": [
            "Incharge_team",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N014",
        "name": "พว. ภัทรนิษฐ์ อ่างนิลพันธ์",
        "headCode": 5,
        "roles": [
            "Incharge_team",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N015",
        "name": "พว. วรรณพร ฬานันท์",
        "headCode": 5,
        "roles": [
            "Fast_track",
            "Triage",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N016",
        "name": "พว. เพ็ญพิชชา เจียมจรรยา",
        "headCode": 5,
        "roles": [
            "Fast_track",
            "Triage",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N017",
        "name": "พว. เจนจิรา เจริญแพทย์",
        "headCode": 5,
        "roles": [
            "Fast_track",
            "Triage",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N018",
        "name": "พว. พรธิดี บัวคำ",
        "headCode": 5,
        "roles": [
            "Fast_track",
            "Triage",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N019",
        "name": "พว. ภัคคีมา ทรัพย์เมือง",
        "headCode": 5,
        "roles": [
            "Inc_proc",
            "Med_proc",
            "Screen_6_8",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N020",
        "name": "พว. ธันย์ชนก อัศวโสวรรณ",
        "headCode": 5,
        "roles": [
            "Inc_proc",
            "Med_proc",
            "Screen_6_8",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N021",
        "name": "พว. ณัฎฐธิดา น้อยศรี",
        "headCode": 5,
        "roles": [
            "Inc_proc",
            "Med_proc",
            "Screen_6_8",
            "Med"
        ],
        "level": 2
    },
    {
        "id": "N022",
        "name": "พว. ธงชัย เกษลา",
        "headCode": 5,
        "roles": [
            "Screen_center",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N023",
        "name": "พว. ชัยภัทร บุญตันกัน",
        "headCode": 5,
        "roles": [
            "Screen_center",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N024",
        "name": "พว. กชกร เยือกเย็น",
        "headCode": 5,
        "roles": [
            "Screen_center",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N025",
        "name": "พว. กัณฑิยา แซ่เล้า",
        "headCode": 5,
        "roles": [
            "Screen_center",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N026",
        "name": "พว. ศาธิตา บุตรสุด",
        "headCode": 5,
        "roles": [
            "Screen_center",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N027",
        "name": "พว. ลักษิกา ชูรีรักษ์",
        "headCode": 5,
        "roles": [
            "Proc_16_20",
            "Screen_16_20",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N028",
        "name": "พว. ประภัสสร ธัญญานนท์",
        "headCode": 5,
        "roles": [
            "Proc_16_20",
            "Screen_16_20",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N029",
        "name": "พว. ภัคจิรา อังคณานันท์",
        "headCode": 5,
        "roles": [
            "Proc_16_20",
            "Screen_16_20",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N030",
        "name": "พว. ลักษมณ ป้องบุญจันทร์",
        "headCode": 5,
        "roles": [
            "Proc_16_20",
            "Screen_16_20",
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N031",
        "name": "พว. ณัฐนพิน บุญประสพ",
        "headCode": 5,
        "roles": [
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N032",
        "name": "พว. โปษิณ ท่าทราย",
        "headCode": 5,
        "roles": [
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N033",
        "name": "พว. ธีระศักดิ์ อินตู",
        "headCode": 5,
        "roles": [
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N034",
        "name": "พว. กัลติษา บุญมณี",
        "headCode": 5,
        "roles": [
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N035",
        "name": "พว. พิชญานิน เดชบุญญาภิชาติ",
        "headCode": 5,
        "roles": [
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N036",
        "name": "พว. ธันย์ชนก อัศวโสวรรณ",
        "headCode": 5,
        "roles": [
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N037",
        "name": "พว. รัตนาภรณ์ โพธิไพรัตนา",
        "headCode": 5,
        "roles": [
            "Med"
        ],
        "level": 1
    },
    {
        "id": "N038",
        "name": "Nurse 38",
        "headCode": 5,
        "roles": [
            "Med",
            "Screen_6_8",
            "Screen_16_20"
        ],
        "level": 1
    }
];

// ──────────────────── Admin Password ────────────────────
const ADMIN_PASSWORD = 'admin1234';
