/* ============================================================
   scheduler.js — Scheduling Engine ระบบจัดตารางเวรพยาบาล
   ============================================================ */

class NurseScheduler {
    constructor(nurses, month, year, prevSchedule = {}) {
        this.nurses = JSON.parse(JSON.stringify(nurses));
        this.month = month;   // 0-indexed
        this.year = year;
        this.daysInMonth = new Date(year, month + 1, 0).getDate();
        this.schedule = {};   // { "YYYY-MM-DD": { M: [...], A: [...], N: [...] } }
        this.leaves = {};     // { "YYYY-MM-DD": [ { nurseId, leaveType, urgent, reason } ] }
        this.prevSchedule = prevSchedule; // { "YYYY-MM-DD": { M: [...], A: [...], N: [...] } }
        this.swaps = [];      // history of swaps
        this.counters = {};   // { nurseId: { M:0, A:0, N:0, total:0 } }
        this.locked = false;
        this.lastUpdate = null;

        // Init counters
        this.nurses.forEach(n => {
            this.counters[n.id] = { M: 0, A: 0, N: 0, total: 0 };
        });
    }

    setLeaves(leaveList) {
        // leaveList: [ { nurseId, dateStr, leaveType } ]
        leaveList.forEach(l => {
            if (!this.leaves[l.dateStr]) this.leaves[l.dateStr] = [];
            this.leaves[l.dateStr].push(l);
        });
    }

    // ──────────────── Date Helpers ────────────────
    dateStr(day) {
        return `${this.year}-${String(this.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    getDayOfWeek(day) {
        return new Date(this.year, this.month, day).getDay(); // 0=Sun, 6=Sat
    }

    isWeekend(day) {
        const d = this.getDayOfWeek(day);
        return d === 0 || d === 6;
    }

    // ──────────────── Constraint Checks ────────────────

    /** Check headCode constraints (relaxedShift allows A shift for headCode 8/9 in shortage case) */
    canAssignShift(nurse, shift, day, relaxedShift = false) {
        const hc = nurse.headCode;
        const weekend = this.isWeekend(day);

        if (hc === 9) {
            if (shift !== 'M') {
                if (!(relaxedShift && shift === 'A')) return false;
            }
        }
        if (hc === 8) {
            if (shift !== 'M') {
                if (!(relaxedShift && shift === 'A')) return false;
            }
        }
        if (hc === 7) {
            if (shift === 'N') return false;
            if (shift === 'A' && weekend) return false;
        }
        return true;
    }

    /** Check headCode 8 for Incharge roles on weekday */
    canAssignRole(nurse, role, shift, day) {
        if (nurse.headCode === 8) {
            if ((role === 'Incharge1' || role === 'Incharge_team') && !this.isWeekend(day)) {
                return false;
            }
        }
        // Procedure morning (ชG) only on weekdays
        if (this.isWeekend(day) && (role === 'Inc_proc' || role === 'Med_proc')) {
            return false;
        }
        if (nurse.screenWeekdayOnly) {
            const screenRoles = ['Screen_center', 'Inc_screen_center', 'Screen_6_8', 'Screen_16_20'];
            if (screenRoles.includes(role) && this.isWeekend(day)) {
                return false;
            }
        }
        if (nurse.procWeekdayOnly) {
            const procRoles = ['Inc_proc', 'Med_proc'];
            if (procRoles.includes(role) && this.isWeekend(day)) {
                return false;
            }
        }
        // Screen 6-8 must be able to continue in morning (Screen_center or ER/Med)
        if (role === 'Screen_6_8') {
            const canContinue = nurse.roles.includes('Screen_center') || nurse.roles.includes('Inc_screen_center') || nurse.roles.includes('Med');
            if (!canContinue) return false;
        }
        // Morning-only roles
        if (MORNING_ONLY_ROLES.includes(role) && shift !== 'M') return false;

        // Must have the role in their capabilities
        if (!nurse.roles.includes(role)) return false;

        return true;
    }

    /** Check forbidden transitions (cross-day) */
    hasForbiddenTransition(nurseId, shift, day) {
        const prevDayData = this._getPrevDayDetails(day, 1);
        if (!prevDayData) return false;

        for (const ft of FORBIDDEN_TRANSITIONS) {
            if (ft.next === shift) {
                const prevShiftAssignments = prevDayData[ft.prev] || [];
                if (prevShiftAssignments.some(a => a.nurseId === nurseId)) return true;
            }
        }
        return false;
    }

    /** Internal helper to get schedule data for previous days (supports cross-month) */
    _getPrevDayDetails(currentDay, daysBack) {
        const targetDay = currentDay - daysBack;
        if (targetDay >= 1) {
            const ds = this.dateStr(targetDay);
            return this.schedule[ds];
        } else {
            // Check prevSchedule
            const prevMonthDate = new Date(this.year, this.month, targetDay);
            const ds = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}-${String(prevMonthDate.getDate()).padStart(2, '0')}`;
            return this.prevSchedule[ds];
        }
    }

    /** Check forbidden transitions forward (next day) */
    hasForbiddenTransitionForward(nurseId, shift, day) {
        if (day >= this.daysInMonth) return false;
        const nextDate = this.dateStr(day + 1);
        const nextDay = this.schedule[nextDate];
        if (!nextDay) return false;

        for (const ft of FORBIDDEN_TRANSITIONS) {
            if (ft.prev === shift) {
                const nextShiftAssignments = nextDay[ft.next] || [];
                if (nextShiftAssignments.some(a => a.nurseId === nurseId)) return true;
            }
        }
        return false;
    }

    /** Check if nurse can take another shift on the same day */
    canAssignSameDay(nurseId, day, shift) {
        const ds = this.dateStr(day);
        const daySchedule = this.schedule[ds];
        if (!daySchedule) return true;

        const hasM = (daySchedule.M || []).some(a => a.nurseId === nurseId);
        const hasA = (daySchedule.A || []).some(a => a.nurseId === nurseId);
        const hasN = (daySchedule.N || []).some(a => a.nurseId === nurseId);

        const total = (hasM ? 1 : 0) + (hasA ? 1 : 0) + (hasN ? 1 : 0);
        if (total === 0) return true;
        if (total >= 2) return false; // allow at most 2 shifts/day

        // Allow only M+A or M+N combinations (any order)
        if (hasM) return (shift === 'A' || shift === 'N') && !hasA && !hasN;
        if (hasA) return shift === 'M' && !hasM && !hasN;
        if (hasN) return shift === 'M' && !hasM && !hasA;
        return false;
    }

    /** Check M/A consecutive days (max 3) */
    wouldExceedConsecutiveMA(nurseId, shift, day) {
        if (shift !== 'M' && shift !== 'A') return false;
        let count = 0;
        // Check backwards up to MAX_CONSECUTIVE_MA
        for (let i = 1; i <= MAX_CONSECUTIVE_MA; i++) {
            const prevDayData = this._getPrevDayDetails(day, i);
            if (!prevDayData) break;

            const inMA = ['M', 'A'].some(s =>
                (prevDayData[s] || []).some(a => a.nurseId === nurseId)
            );
            if (inMA) count++;
            else break;
        }
        return count >= (typeof MAX_CONSECUTIVE_MA !== 'undefined' ? MAX_CONSECUTIVE_MA : 3);
    }

    /** Check if nurse is on leave */
    isOnLeave(nurseId, day) {
        const ds = this.dateStr(day);
        return (this.leaves[ds] || []).some(l => l.nurseId === nurseId);
    }

    /** Prefer avoid night-night consecutive */
    hasConsecutiveNight(nurseId, day) {
        const prevDayData = this._getPrevDayDetails(day, 1);
        if (!prevDayData) return false;
        return (prevDayData.N || []).some(a => a.nurseId === nurseId);
    }

    // ──────────────── Fairness Scoring ────────────────
    fairnessScore(nurseId, shift) {
        const c = this.counters[nurseId];
        // Primary: balance per-shift counts (stronger weight)
        // Secondary: overall total shifts
        // Tertiary: avoid too many nights when assigning other shifts
        const shiftCount = (c[shift] || 0);
        const shiftWeight = 1000;
        const totalWeight = 50;
        const nightWeight = 150;
        const nightPenalty = (shift !== 'N') ? (c.N * nightWeight) : 0;
        return (shiftCount * shiftWeight) + (c.total * totalWeight) + nightPenalty;
    }

    // ──────────────── Generate Schedule ────────────────
    generate() {
        this.schedule = {};
        // Reset counters
        this.nurses.forEach(n => {
            this.counters[n.id] = { M: 0, A: 0, N: 0, total: 0 };
        });

        // Add randomization to nurses list to ensure different results each time
        // but keep the original order for fairness within a single run
        this.shuffledNurses = [...this.nurses].sort(() => Math.random() - 0.5);

        for (let day = 1; day <= this.daysInMonth; day++) {
            const ds = this.dateStr(day);
            this.schedule[ds] = { M: [], A: [], N: [] };

            for (const shift of ['M', 'A', 'N']) {
                this._fillShift(day, shift);
            }
        }

        this.locked = true;
        this.lastUpdate = new Date().toISOString();
        return this.schedule;
    }

    _fillShift(day, shift) {
        const ds = this.dateStr(day);
        const rolesNeeded = JSON.parse(JSON.stringify(ROLE_MINIMUMS[shift] || []));
        const assignedIds = new Set();

        // Step 1: Fill mandatory roles
        for (const rn of rolesNeeded) {
            for (let i = 0; i < rn.count; i++) {
                let candidates = this._getCandidates(day, shift, rn.role, assignedIds, false);
                if (candidates.length === 0 && shift === 'A') {
                    // Shortage override: allow headCode 8/9 to take A when no candidates
                    candidates = this._getCandidates(day, shift, rn.role, assignedIds, true);
                }
                if (candidates.length > 0) {
                    const chosen = candidates[0];
                    this.schedule[ds][shift].push({
                        nurseId: chosen.id,
                        nurseName: chosen.name,
                        role: rn.role,
                        roleLabel: ROLE_LABELS[rn.role] || rn.role,
                        isLeave: false,
                    });
                    assignedIds.add(chosen.id);
                    this.counters[chosen.id][shift]++;
                    this.counters[chosen.id].total++;
                } else {
                    // Mark as shortage
                    this.schedule[ds][shift].push({
                        nurseId: null,
                        nurseName: '(ขาดคน)',
                        role: rn.role,
                        roleLabel: ROLE_LABELS[rn.role] || rn.role,
                        isLeave: false,
                        isShortage: true,
                    });
                }
            }
        }

        // Step 2: Fill remaining with Med to reach quota
        const quota = SHIFT_QUOTA[shift];
        let current = this.schedule[ds][shift].filter(a => !a.isShortage).length;
        while (current < quota) {
            let candidates = this._getCandidates(day, shift, 'Med', assignedIds, false);
            if (candidates.length === 0 && shift === 'A') {
                // Shortage override: allow headCode 8/9 to take A when no candidates
                candidates = this._getCandidates(day, shift, 'Med', assignedIds, true);
            }
            if (candidates.length === 0) break;
            const chosen = candidates[0];
            this.schedule[ds][shift].push({
                nurseId: chosen.id,
                nurseName: chosen.name,
                role: 'Med',
                roleLabel: ROLE_LABELS['Med'],
                isLeave: false,
            });
            assignedIds.add(chosen.id);
            this.counters[chosen.id][shift]++;
            this.counters[chosen.id].total++;
            current++;
        }
    }

    _getCandidates(day, shift, role, excludeIds, relaxedShift = false) {
        return this.shuffledNurses
            .filter(n => {
                if (excludeIds.has(n.id)) return false;
                if (!this.canAssignShift(n, shift, day, relaxedShift)) return false;
                if (!this.canAssignRole(n, role, shift, day)) return false;
                if (!this.canAssignSameDay(n.id, day, shift)) return false;
                if (this.isOnLeave(n.id, day)) return false;
                if (this.hasForbiddenTransition(n.id, shift, day)) return false;
                if (this.wouldExceedConsecutiveMA(n.id, shift, day)) return false;
                return true;
            })
            .sort((a, b) => {
                const scoreA = this.fairnessScore(a.id, shift);
                const scoreB = this.fairnessScore(b.id, shift);
                if (scoreA !== scoreB) return scoreA - scoreB;

                // Avoid consecutive night
                const nightA = this.hasConsecutiveNight(a.id, day) ? 1 : 0;
                const nightB = this.hasConsecutiveNight(b.id, day) ? 1 : 0;
                if (nightA !== nightB) return nightA - nightB;

                // Prefer higher level (less usage of level 2 unnecessarily)
                if (role === 'Med') {
                    if (a.level !== b.level) return a.level - b.level; // lower level first for Med
                }

                return 0;
            });
    }

    // ──────────────── Leave System ────────────────
    addLeave(nurseId, dateStr, leaveType, urgent = false, reason = '') {
        if (!this.leaves[dateStr]) this.leaves[dateStr] = [];
        // Prevent duplicate
        if (this.leaves[dateStr].some(l => l.nurseId === nurseId)) return false;

        const nurse = this.nurses.find(n => n.id === nurseId);
        this.leaves[dateStr].push({
            nurseId,
            nurseName: nurse ? nurse.name : nurseId,
            leaveType,
            urgent,
            reason,
        });

        // Mark leave in schedule
        if (this.schedule[dateStr]) {
            if (leaveType === 'preceptor') {
                // Remove any existing assignments for that day (no staffing counted)
                for (const shift of ['M', 'A', 'N']) {
                    const assignments = this.schedule[dateStr][shift] || [];
                    this.schedule[dateStr][shift] = assignments.filter(a => a.nurseId !== nurseId);
                }
            }

            let marked = false;
            for (const shift of ['M', 'A', 'N']) {
                const assignments = this.schedule[dateStr][shift];
                const idx = assignments.findIndex(a => a.nurseId === nurseId);
                if (idx >= 0) {
                    assignments[idx].isLeave = true;
                    assignments[idx].leaveType = leaveType;
                    assignments[idx].urgent = urgent;
                    marked = true;
                }
            }

            // For Preceptor leave, show as morning+ in schedule (non-staffing)
            if (leaveType === 'preceptor' && !marked) {
                if (!this.schedule[dateStr].M) this.schedule[dateStr].M = [];
                this.schedule[dateStr].M.push({
                    nurseId,
                    nurseName: nurse ? nurse.name : nurseId,
                    role: 'Preceptor',
                    roleLabel: 'Preceptor P',
                    isLeave: true,
                    leaveType,
                    urgent,
                    isLeavePlaceholder: true
                });
            }
        }

        this.lastUpdate = new Date().toISOString();
        return true;
    }

    removeLeave(nurseId, dateStr) {
        if (!this.leaves[dateStr]) return false;
        const idx = this.leaves[dateStr].findIndex(l => l.nurseId === nurseId);
        if (idx < 0) return false;
        this.leaves[dateStr].splice(idx, 1);

        // Unmark in schedule
        if (this.schedule[dateStr]) {
            for (const shift of ['M', 'A', 'N']) {
                const assignments = this.schedule[dateStr][shift];
                const aidx = assignments.findIndex(a => a.nurseId === nurseId);
                if (aidx >= 0) {
                    if (assignments[aidx].isLeavePlaceholder) {
                        assignments.splice(aidx, 1);
                        continue;
                    }
                    assignments[aidx].isLeave = false;
                    delete assignments[aidx].leaveType;
                    delete assignments[aidx].urgent;
                }
            }
        }
        return true;
    }

    // ──────────────── Swap System ────────────────
    getReplacementOptions(nurseId, dateStr, shift, relaxed = false) {
        const daySchedule = this.schedule[dateStr];
        if (!daySchedule) return [];

        const assignment = daySchedule[shift].find(a => a.nurseId === nurseId);
        if (!assignment) return [];

        const role = assignment.role;
        const day = parseInt(dateStr.split('-')[2]);
        const targetNurse = this.nurses.find(n => n.id === nurseId);

        const candidates = [];

        this.nurses.forEach(n => {
            if (n.id === nurseId) return;

            // --- HARD RULES (Non-negotiable) ---
            if (!this.canAssignSameDay(n.id, day, shift)) return;
            if (this.isOnLeave(n.id, day)) return;

            // --- SOFT RULES (Negotiable in emergency) ---
            const violations = [];
            if (!this.canAssignRole(n, role, shift, day)) violations.push('บทบาท/ทักษะไม่ตรงกัน');
            if (!this.canAssignShift(n, shift, day)) violations.push('ติดเงื่อนไข HeadCode');
            if (this.hasForbiddenTransition(n.id, shift, day)) violations.push('กฎการต่อเวรไม่เหมาะสม');
            if (this.wouldExceedConsecutiveMA(n.id, shift, day)) violations.push('ทำงานติดต่อกันเกินกำหนด');

            if (!relaxed && violations.length > 0) return;

            candidates.push({
                nurse: n,
                violations: violations
            });
        });

        return candidates
            .sort((a, b) => {
                // Priority 1: Fewer violations (Rules priority)
                if (a.violations.length !== b.violations.length) return a.violations.length - b.violations.length;

                // Priority 2: Level matching
                const levelDiffA = Math.abs(a.nurse.level - targetNurse.level);
                const levelDiffB = Math.abs(b.nurse.level - targetNurse.level);
                if (levelDiffA !== levelDiffB) return levelDiffA - levelDiffB;

                // Priority 3: Fairness
                const ca = this.counters[a.nurse.id];
                const cb = this.counters[b.nurse.id];
                if (ca[shift] !== cb[shift]) return ca[shift] - cb[shift];
                return ca.total - cb.total;
            });
    }

    /** Find which shift a nurse is in on a given date */
    findNurseShift(nurseId, dateStr) {
        const daySchedule = this.schedule[dateStr];
        if (!daySchedule) return null;
        for (const shift of ['M', 'A', 'N']) {
            if (daySchedule[shift].some(a => a.nurseId === nurseId)) return shift;
        }
        return null;
    }

    executeSwap(originalNurseId, replacementNurseId, dateStr, shift) {
        const daySchedule = this.schedule[dateStr];
        if (!daySchedule) return { success: false, error: 'ไม่พบข้อมูลวันนี้' };

        const assignments = daySchedule[shift];
        const idx = assignments.findIndex(a => a.nurseId === originalNurseId);
        if (idx < 0) return { success: false, error: 'ไม่พบเวรของคนเดิม' };

        const replacement = this.nurses.find(n => n.id === replacementNurseId);
        if (!replacement) return { success: false, error: 'ไม่พบข้อมูลคนแทน' };

        const original = assignments[idx];

        // Save swap history
        this.swaps.push({
            date: dateStr,
            shift,
            role: original.role,
            originalNurseId,
            originalNurseName: original.nurseName,
            replacementNurseId,
            replacementNurseName: replacement.name,
            timestamp: new Date().toISOString(),
        });

        // Update counters
        this.counters[originalNurseId][shift]--;
        this.counters[originalNurseId].total--;
        this.counters[replacementNurseId][shift]++;
        this.counters[replacementNurseId].total++;

        // Update assignment
        assignments[idx] = {
            ...original,
            nurseId: replacementNurseId,
            nurseName: replacement.name,
            isLeave: false,
            swappedFrom: originalNurseId,
        };

        this.lastUpdate = new Date().toISOString();
        return { success: true };
    }

    // ──────────────── Alerts ────────────────
    getAlerts(dateStr) {
        const daySchedule = this.schedule[dateStr];
        if (!daySchedule) return [];

        const alerts = [];

        for (const shift of ['M', 'A', 'N']) {
            const assignments = daySchedule[shift];
            const working = assignments.filter(a => !a.isLeave && !a.isShortage);
            const quota = SHIFT_QUOTA[shift];

            // Quota check
            if (working.length < quota) {
                alerts.push({
                    shift,
                    type: 'quota',
                    message: `${SHIFT_LABELS[shift]}: มีคนทำงาน ${working.length}/${quota} คน (ขาด ${quota - working.length})`,
                    severity: 'warning',
                });
            }

            // Role check
            const roleMin = ROLE_MINIMUMS[shift] || [];
            for (const rm of roleMin) {
                const filledCount = working.filter(a => a.role === rm.role).length;
                if (filledCount < rm.count) {
                    alerts.push({
                        shift,
                        type: 'role',
                        message: `${SHIFT_LABELS[shift]}: ${ROLE_LABELS[rm.role] || rm.role} มี ${filledCount}/${rm.count} คน`,
                        severity: 'error',
                    });
                }
            }
        }

        return alerts;
    }

    // ──────────────── Stats ────────────────
    getStats() {
        const stats = {};
        const leaveTypeKeys = (typeof LEAVE_TYPES !== 'undefined')
            ? Object.keys(LEAVE_TYPES)
            : ['off', 'personal', 'sick', 'vacation', 'training', 'preceptor', 'education', 'religious', 'military', 'maternity', 'paternity', 'sterilization'];
        this.nurses.forEach(n => {
            const c = this.counters[n.id];
            const leaveCount = { total: 0 };
            leaveTypeKeys.forEach(k => { leaveCount[k] = 0; });
            Object.values(this.leaves).forEach(dayLeaves => {
                dayLeaves.forEach(l => {
                    if (l.nurseId === n.id) {
                        leaveCount[l.leaveType] = (leaveCount[l.leaveType] || 0) + 1;
                        leaveCount.total++;
                    }
                });
            });

            stats[n.id] = {
                id: n.id,
                name: n.name,
                headCode: n.headCode,
                level: n.level,
                shifts: { ...c },
                leaves: leaveCount,
            };
        });
        return stats;
    }

    // ──────────────── Export Helpers ────────────────
    exportCalendarCSV() {
        const shiftCode = (shift, role, suffix = '') => {
            const base = shift === 'M' ? 'ช' : (shift === 'A' ? 'บ' : (shift === 'N' ? 'ด' : shift));
            if (suffix) return shift === 'M' ? `${base}${suffix}` : base;
            const isIncharge = typeof role === 'string' && role.toLowerCase().includes('incharge');
            return isIncharge ? `${base}i` : base;
        };
        const leaveCode = (leaveType) => {
            switch (leaveType) {
                case 'off': return 'off';
                case 'personal': return 'ก';
                case 'sick': return 'ป';
                case 'vacation': return 'ผ';
                case 'training': return 'อ';
                case 'preceptor': return 'ชP';
                case 'education': return 'ศษ';
                case 'religious': return 'ศ';
                case 'military': return 'ต';
                case 'maternity': return 'ค';
                case 'paternity': return 'ชภ';
                case 'sterilization': return 'ท';
                default: return 'ลา';
            }
        };

        let csv = 'รหัส,ชื่อ';
        for (let d = 1; d <= this.daysInMonth; d++) {
            csv += `,${d}`;
        }
        csv += '\n';

        this.nurses.forEach(n => {
            const fallbackName = (typeof activeNurses !== 'undefined' && Array.isArray(activeNurses))
                ? (activeNurses.find(x => x.id === n.id)?.name || '')
                : '';
            const displayName = n.name || fallbackName || n.id;
            let row = `${n.id},${displayName}`;
            for (let d = 1; d <= this.daysInMonth; d++) {
                const ds = this.dateStr(d);
                const dayLeaves = (this.leaves && this.leaves[ds]) ? this.leaves[ds] : [];
                const leaveHit = dayLeaves.find(l => l.nurseId === n.id);
                if (leaveHit) {
                    row += `,"${leaveCode(leaveHit.leaveType)}"`;
                    continue;
                }
                let shifts = [];
                const daySchedule = this.schedule[ds];
                if (daySchedule) {
                    for (const shift of ['M', 'A', 'N']) {
                        const a = daySchedule[shift].find(x => x.nurseId === n.id);
                        if (a) {
                            if (a.isLeave) {
                                const code = leaveCode(a.leaveType);
                                shifts.push(code);
                            } else {
                                shifts.push(shiftCode(shift, a.role));
                            }
                        }
                    }
                }
                const val = shifts.length > 0 ? shifts.join('/') : '-';
                row += `,"${val}"`;
            }
            csv += row + '\n';
        });
        return csv;
    }

    exportCalendarCSVByRole() {
        const shiftCode = (shift, role) => {
            const base = shift === 'M' ? 'ช' : (shift === 'A' ? 'บ' : (shift === 'N' ? 'ด' : shift));
            const isIncharge = typeof role === 'string' && role.toLowerCase().includes('incharge');
            return isIncharge ? `${base}i` : base;
        };
        const leaveCode = (leaveType) => {
            switch (leaveType) {
                case 'off': return 'off';
                case 'personal': return 'ก';
                case 'sick': return 'ป';
                case 'vacation': return 'ผ';
                case 'training': return 'อ';
                case 'preceptor': return 'ชP';
                case 'education': return 'ศษ';
                case 'religious': return 'ศ';
                case 'military': return 'ต';
                case 'maternity': return 'ค';
                case 'paternity': return 'ชภ';
                case 'sterilization': return 'ท';
                default: return 'ลา';
            }
        };

        const roleRows = [
            {
                label: 'ER',
                suffix: '',
                roles: new Set(['Head', 'Incharge1', 'Incharge_team', 'Fast_track', 'Triage', 'Med']),
                autoFill: true,
                showLeave: true
            },
            {
                label: 'หัตถการ',
                suffix: 'G',
                roles: new Set(['Inc_proc', 'Med_proc', 'Proc_16_20']),
                autoFill: true,
                showLeave: false
            },
            {
                label: 'คัดกรอง',
                suffix: 'S',
                roles: new Set(['Screen_center', 'Inc_screen_center', 'Screen_6_8', 'Screen_16_20']),
                autoFill: true,
                showLeave: false
            }
        ];

        let csv = 'ชื่อ,ตำแหน่ง';
        for (let d = 1; d <= this.daysInMonth; d++) {
            csv += `,${d}`;
        }
        csv += '\n';

        this.nurses.forEach(n => {
            const fallbackName = (typeof activeNurses !== 'undefined' && Array.isArray(activeNurses))
                ? (activeNurses.find(x => x.id === n.id)?.name || '')
                : '';
            const displayName = n.name || fallbackName || n.id;

            roleRows.forEach(rowDef => {
                let row = `${displayName},${rowDef.label}`;
                for (let d = 1; d <= this.daysInMonth; d++) {
                    const ds = this.dateStr(d);
                    let leaveVal = null;
                    if (rowDef.showLeave) {
                        const dayLeaves = (this.leaves && this.leaves[ds]) ? this.leaves[ds] : [];
                        const leaveHit = dayLeaves.find(l => l.nurseId === n.id);
                        if (leaveHit) leaveVal = leaveCode(leaveHit.leaveType);
                    }
                    if (leaveVal) {
                        row += `,"${leaveVal}"`;
                        continue;
                    }

                    const daySchedule = this.schedule[ds];
                    let shifts = [];
                    if (rowDef.autoFill && daySchedule) {
                        for (const shift of ['M', 'A', 'N']) {
                            const a = daySchedule[shift].find(x => x.nurseId === n.id);
                            if (a && !a.isLeave && rowDef.roles.has(a.role)) {
                                if (rowDef.label === 'คัดกรอง' && a.role === 'Screen_6_8') {
                                    shifts.push('6');
                                } else {
                                    shifts.push(shiftCode(shift, a.role, rowDef.suffix));
                                }
                            }
                        }
                    }
                    const val = shifts.length > 0 ? shifts.join('/') : '-';
                    row += `,"${val}"`;
                }
                csv += row + '\n';
            });
        });

        return csv;
    }

    exportStatsCSV() {
        const stats = this.getStats();
        const leaveTypeKeys = (typeof LEAVE_TYPES !== 'undefined')
            ? Object.keys(LEAVE_TYPES)
            : ['off', 'personal', 'sick', 'vacation', 'training', 'preceptor', 'education', 'religious', 'military', 'maternity', 'paternity', 'sterilization'];
        const leaveLabels = leaveTypeKeys.map(k => (typeof LEAVE_TYPES !== 'undefined' && LEAVE_TYPES[k]) ? LEAVE_TYPES[k].label : k);
        let csv = `รหัส,ชื่อ,HeadCode,Level,เช้า(M),บ่าย(A),ดึก(N),รวมเวร,${leaveLabels.join(',')},รวมลา\n`;
        Object.values(stats)
            .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
            .forEach(s => {
                const leaveCounts = leaveTypeKeys.map(k => s.leaves[k] || 0);
                csv += `${s.id},${s.name},${s.headCode},${s.level},${s.shifts.M},${s.shifts.A},${s.shifts.N},${s.shifts.total},${leaveCounts.join(',')},${s.leaves.total}\n`;
            });
        return csv;
    }

    // ──────────────── Serialization ────────────────
    toJSON() {
        return {
            month: this.month,
            year: this.year,
            daysInMonth: this.daysInMonth,
            schedule: this.schedule,
            leaves: this.leaves,
            swaps: this.swaps,
            counters: this.counters,
            locked: this.locked,
            lastUpdate: this.lastUpdate,
        };
    }

    loadFromJSON(data) {
        this.month = data.month;
        this.year = data.year;
        this.daysInMonth = data.daysInMonth || new Date(this.year, this.month + 1, 0).getDate();
        this.schedule = data.schedule || {};
        this.leaves = data.leaves || {};
        this.swaps = data.swaps || [];
        this.counters = data.counters || {};
        this.locked = data.locked || false;
        this.lastUpdate = data.lastUpdate;
    }

    rebuildCounters() {
        // Reset
        this.nurses.forEach(n => {
            if (!this.counters[n.id]) this.counters[n.id] = { M: 0, A: 0, N: 0, total: 0 };
            this.counters[n.id] = { M: 0, A: 0, N: 0, total: 0 };
        });
        // Recalculate
        Object.values(this.schedule).forEach(day => {
            ['M', 'A', 'N'].forEach(s => {
                if (day[s]) {
                    day[s].forEach(a => {
                        if (!a.isShortage && !a.isLeave) {
                            if (this.counters[a.nurseId]) {
                                this.counters[a.nurseId][s]++;
                                this.counters[a.nurseId].total++;
                            }
                        }
                    });
                }
            });
        });
    }
}
