// Tombol tiga garis di halaman Anomaly Alert Center dan Data & Reports: menampilkan / menyembunyikan menu samping.
// Pilihan terakhir diingat di browser ini saja.
(function () {
  const KEY = "ocean-nexus-nav-hidden";

  // F3-S: tombol Sign out. Sesi login di server diakhiri (cookie dihapus), lalu kembali ke halaman login.
  document.addEventListener("click", async (event) => {
    const logout = event.target.closest?.("[data-onx-logout]");
    if (!logout) return;
    logout.disabled = true;
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.warn("[onx-nav] logout gagal:", error);
    }
    try {
      sessionStorage.removeItem("onx-login");
    } catch (error) {
      // penyimpanan diblokir: abaikan
    }
    location.replace("index.html?keluar=1");
  });

  document.addEventListener("DOMContentLoaded", () => {
    const shell = document.querySelector(".onx-shell");
    const button = document.getElementById("onx-menu-toggle");
    if (!shell || !button) return;

    let hidden = false;
    try {
      hidden = localStorage.getItem(KEY) === "1";
    } catch (error) {
      // penyimpanan diblokir: menu tetap tampil seperti biasa
    }

    const apply = () => {
      shell.classList.toggle("is-nav-hidden", hidden);
      button.setAttribute("aria-expanded", String(!hidden));
      button.title = hidden ? "Tampilkan menu" : "Sembunyikan menu";
    };
    apply();

    button.addEventListener("click", () => {
      hidden = !hidden;
      try {
        localStorage.setItem(KEY, hidden ? "1" : "0");
      } catch (error) {
        // abaikan
      }
      apply();
    });
  });
})();
