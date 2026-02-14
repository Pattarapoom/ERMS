# 🔥 คู่มือติดตั้ง Firebase สำหรับ ERMS

## ขั้นตอนที่ 1: สร้างโปรเจกต์ Firebase

1. เปิดเบราว์เซอร์ไปที่ [Firebase Console](https://console.firebase.google.com/)
2. ล็อกอินด้วย **Google Account** (Gmail) ของคุณ
3. กดปุ่ม **"Add project"** หรือ **"เพิ่มโปรเจกต์"**
4. ตั้งชื่อโปรเจกต์: `ERMS` (หรือชื่ออื่นที่คุณต้องการ)
5. ปิด Google Analytics (ไม่จำเป็นสำหรับโปรเจกต์นี้)
6. กดปุ่ม **"Create project"** และรอสักครู่

---

## ขั้นตอนที่ 2: เปิดใช้งาน Realtime Database

1. ในหน้า Firebase Console ของโปรเจกต์ที่สร้างแล้ว
2. ไปที่เมนูด้านซ้าย: **Build > Realtime Database**
3. กดปุ่ม **"Create Database"**
4. เลือก Location: **Singapore (asia-southeast1)** (ใกล้ไทยที่สุด)
5. เลือกโหมด Security Rules: **"Start in test mode"** (ชั่วคราว เพื่อทดสอบ)
6. กดปุ่ม **"Enable"**

---

## ขั้นตอนที่ 3: รับรหัส API Key

1. กลับไปที่หน้าหลัก Firebase Console
2. กดไอคอน **`</>`** (Web) ใต้ชื่อโปรเจกต์
3. ตั้งชื่อแอป: `ERMS-Web`
4. **ไม่ต้อง** เลือก Firebase Hosting
5. กดปุ่ม **"Register app"**
6. คุณจะเห็นโค้ดคล้ายๆ นี้:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "erms-xxxxx.firebaseapp.com",
  databaseURL: "https://erms-xxxxx-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "erms-xxxxx",
  storageBucket: "erms-xxxxx.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdefghijklmnop"
};
```

7. **คัดลอกค่าทั้งหมดนี้** (จะนำไปใส่ในโค้ดในขั้นตอนถัดไป)

---

## ขั้นตอนที่ 4: ใส่รหัสลงในโค้ด

1. เปิดไฟล์ `/Users/ribbin/Documents/ERMS/firebase-config.js` (ผมจะสร้างให้)
2. วางค่า `firebaseConfig` ที่คัดลอกมาแทนที่ในไฟล์นั้น
3. บันทึกไฟล์

---

## ขั้นตอนที่ 5: ทดสอบระบบ

1. เปิดเว็บ ERMS ในคอมพิวเตอร์
2. ลองจัดตารางเวร
3. เปิดเว็บ ERMS ในมือถือ (URL เดียวกัน)
4. ข้อมูลควรจะขึ้นเหมือนกันทันที! ✨

---

## ⚠️ หมายเหตุสำคัญ

- **ข้อมูลจะถูกเก็บบน Firebase Cloud** (ไม่ใช่ในเครื่องอีกต่อไป)
- **ฟรี**: Firebase มี Free Tier ให้ใช้งานได้เพียงพอสำหรับแผนกพยาบาลขนาดเล็ก-กลาง
- **ความปลอดภัย**: หลังจากทดสอบเสร็จ ควรตั้งค่า Security Rules ให้เข้มงวดขึ้น (ผมจะช่วยตั้งค่าให้ครับ)

---

## 🆘 ต้องการความช่วยเหลือ?

หากมีปัญหาในขั้นตอนใด สามารถส่งภาพหน้าจอมาให้ผมดูได้เลยครับ!
