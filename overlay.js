const notice = document.getElementById("notice");
const mark = document.getElementById("noticeMark");
const title = document.getElementById("noticeTitle");
const message = document.getElementById("noticeMessage");
const status = document.getElementById("noticeStatus");
const successSound = document.getElementById("successSound");
const failureSound = document.getElementById("failureSound");

window.clipOverlay?.onOutcome((result) => {
  const outcome = result?.outcome;
  const saving = outcome === "saving";
  const success = outcome === "success";
  const test = outcome === "test";
  notice.classList.remove("is-visible", "is-leaving", "is-failed", "is-saving", "is-test");
  void notice.offsetWidth;
  notice.classList.toggle("is-failed", !success && !saving && !test);
  notice.classList.toggle("is-saving", saving);
  notice.classList.toggle("is-test", test);
  status.textContent = test ? "Lokale Vorschau" : saving ? "Replay · wird gesichert" : success ? "Replay · gesichert" : "Replay · fehlgeschlagen";
  mark.textContent = test ? "◎" : saving ? "…" : success ? "✓" : "×";
  title.textContent = test ? "Overlay-Test" : saving ? "Clip wird gesichert" : success ? "Clip gespeichert" : "Clip konnte nicht gespeichert werden";
  message.textContent = result?.message || (test ? "Diese lokale Testmeldung wurde angezeigt." : saving ? "Der Clip wird vorbereitet." : success ? "Der Clip liegt in deiner Bibliothek." : "Prüfe den Replay-Puffer und versuche es erneut.");
  notice.classList.add("is-visible");
  if (!saving && !test) {
    const sound = success ? successSound : failureSound;
    if (sound) {
      sound.currentTime = success ? 1.16 : 0.34;
      sound.play().catch(() => {});
    }
  }
});
