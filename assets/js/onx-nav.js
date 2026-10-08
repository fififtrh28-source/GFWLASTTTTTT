// Tombol tiga garis di halaman Anomaly Alert Center dan Data & Reports: menampilkan / menyembunyikan menu samping.
// Pilihan terakhir diingat di browser ini saja.
(function () {
  const KEY = "ocean-nexus-nav-hidden";

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
