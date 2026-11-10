// =====================================================================
// ORIGINAL — copied letter-for-letter from the original KAIF form
// (Gemini canvas "Farm Breakfast Reservation"). Do not edit.
// =====================================================================
export const ORIGINAL = Object.freeze({
  nameLabel: 'اسم الشخص المدعو',
  namePlaceholder: 'أدخل الاسم الكريم',
  dayLabel: 'اختر اليوم المناسب',
  dayPrefix: 'يوم',
  dayAvailable: 'متاح للحجز',
  // original: "وقت الحضور المفضل (من 5:30 ص حتى 9:30 ص)" — the two times now
  // come from the dashboard (requested: 6 ص – 9 ص, editable).
  timeLabel: (from, to) => `وقت الحضور المفضل (من ${from} ص حتى ${to} ص)`,
  am: 'ص',
  peopleLabel: 'إجمالي عدد الأشخاص (الضيف والمرافقين)',
  // original options: 1 شخص واحد · 2 شخصين · 3 أشخاص · 4 أشخاص — extended to 9 on request, same pattern
  people: (n) => (n === 1 ? 'شخص واحد' : n === 2 ? 'شخصين' : `${n} أشخاص`),
  // original: 'يمكن اختيار من 1 إلى 4 أشخاص كحد أقصى لكل دعوة.' — the maximum now follows the dashboard (9)
  peopleNote: (max) => `يمكن اختيار من 1 إلى ${max} أشخاص كحد أقصى لكل دعوة.`,
  submit: 'تأكيد حجز الدعوة',
  // opening (from the original page, verbatim)
  welcomeTitle: 'صباحك بين النخيل في كايف المزرعة',
  welcomeSub: 'نتشرف بحضوركم لتجربة فطور كايف الخاصة',
  welcomeBody: 'تجربة استثنائية وسط أجواء المزرعة الهادئة والمذاق الرفيع. يرجى تأكيد حجزكم لتوفير تجربة تليق بكم.',
});

// =====================================================================
// NEW FUNCTIONAL MESSAGES — not in the original (it had no capacity
// rules). Kept short and plain; replace with the original wording when
// available. Set CONFIRM_TITLE to the original confirmation text.
// =====================================================================
export const FUNCTIONAL = Object.freeze({
  pm: 'م',
  dayFull: 'مكتمل',
  bookingClosed: 'الحجز مغلق حاليًا',
  dayFullError: 'اكتمل العدد لهذا اليوم',
  notEnoughSeats: 'المقاعد المتبقية لهذا اليوم لا تكفي العدد المختار',
  networkError: 'تعذّر الاتصال، حاول مرة أخرى',
  CONFIRM_TITLE: null,
});
