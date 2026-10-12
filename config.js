// Sitenin ayarları. Yayınlamadan önce yalnızca spotifyClientIds'i doldurman yeterli.
// Bu dosyayı yalnızca siteyi yayınlayan kişi düzenler; oyunculardan hiçbir kod istenmez.
window.IVORY_CONFIG = {
  // Spotify Developer Dashboard'da oluşturduğun uygulamanın Client ID'si.
  // Geliştirme modunda her uygulama en fazla 5 Spotify hesabına izin verir. Daha fazla
  // kişiyle oynamak için ikinci, üçüncü… uygulamayı açıp Client ID'lerini buraya ekle:
  //   spotifyClientIds: ['birinci-id', 'ikinci-id'],
  // Oyuncular giriş ekranında kendi eklendikleri grubu (1, 2, …) seçer.
  spotifyClientIds: ['e713b2b651dd48b99cdce3a9d36b9ac9'],

  // Bir odaya girebilecek en fazla oyuncu.
  maxPlayers: 24,

  // Oyunu başlatmak için gereken en az oyuncu. (Yerelde, 127.0.0.1 üzerinde her zaman 1'dir.)
  minPlayers: 2,

  // "Listeme ekle" düğmesinin şarkıları kaydettiği çalma listesinin adı.
  playlistName: 'Ivory',
};
