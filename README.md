# Ivory

Arkadaşlarla oynanan müzik tahmin oyunu. Herkes Spotify hesabıyla odaya girer; geçmişinizden rastgele bir şarkı çalar ve o şarkıyı **kimlerin dinlediğini** tahmin edersiniz.

- Çarktaki dilimlere dokunarak bir ya da birkaç oyuncu seçilir (kendin dahil).
- Her doğru isim **+3**, her yanlış isim **−1** puan.
- Herkes oy verince (ya da süre bitince) dinleyenler açıklanır.
- Odadaki **herkes “Devam” deyince** sıradaki şarkıya geçilir.
- Hedef puana (15 / 30 / 50 / 75) ilk ulaşan kazanır.

Sunucu yoktur: site tamamen statiktir, GitHub Pages'te çalışır. Odayı kuran kişinin tarayıcısı oyunu yönetir.

## Yerelde çalıştırma

```bash
python3 -m http.server 5173 --bind 127.0.0.1
```

Sonra tarayıcıda `http://127.0.0.1:5173/` adresini aç. (`localhost` yazarsan site kendini `127.0.0.1`'e yönlendirir; Spotify yönlendirme adresi olarak `localhost` kabul etmiyor.)

Yerelde oyun **tek kişiyle** başlatılabilir, böylece tek başına deneyebilirsin.

## Spotify kurulumu (bir kez)

1. <https://developer.spotify.com/dashboard> adresinde bir uygulama oluştur. Hesabın **Premium** olmalı. API olarak **Web API** seç.
2. **Redirect URIs** alanına sitenin adresini, sonundaki `/` ile birlikte ekle:
   - yerel deneme için: `http://127.0.0.1:5173/`
   - yayındaki site için: `https://KULLANICI.github.io/DEPO/`

3. Uygulamanın **Client ID** değerini `config.js` içindeki `spotifyClientIds` listesine yaz:

   ```js
   spotifyClientIds: ['buraya-client-id'],
   ```
4. **User Management** bölümünden oynayacak kişilerin Spotify e-postalarını ekle.

Bu kurulumu yalnızca siteyi yayınlayan kişi yapar. **Oyunculardan hiçbir kod istenmez:** kullanıcı adını yazar, Spotify hesabıyla bağlanır ve Spotify'ın açık olduğu cihazı seçer.

### Oyuncu sayısı sınırı

Odaya girmenin tek yolu Spotify hesabıyla bağlanmaktır. Spotify, geliştirme modundaki bir uygulamaya **en fazla 5 hesap** eklenmesine izin veriyor ve her hesabın elle eklenmesini istiyor. Daha fazla kişiyle oynamak için ikinci, üçüncü… uygulamayı açıp Client ID'lerini `config.js`'e ekle:

```js
spotifyClientIds: ['id-1', 'id-2'],
```

Her uygulama 5 hesap daha demektir. Oyuncunun hangi uygulamaya eklendiğini site kendisi bulur: biri kabul etmezse sıradakini dener. Her uygulamada **Redirect URIs** aynı şekilde tanımlı olmalı. Bir odaya en fazla `maxPlayers` (varsayılan 24) kişi girebilir.

### Arkadaş ekleme

Listede olmayan biri bağlanmayı denediğinde site ona Spotify e-postasını sorar (Spotify bu bilgiyi siteye vermez). Oyuncu e-postasını yazıp **Gönder**'e basınca, odayı kuran kişinin ekranında üstte **“istek”** rozeti çıkar; oradan e-postayı kopyalayıp Spotify panelinde **User Management**'a ekle. Oyuncu sonra **“Eklendim, tekrar dene”**ye basar.

## GitHub Pages'te yayınlama

1. GitHub'da yeni bir depo aç (ör. `ivory`) ve bu klasördeki dosyaları yükle.
2. Depoda **Settings → Pages → Build and deployment**: *Deploy from a branch*, dal `main`, klasör `/ (root)`.
3. Birkaç dakika sonra site `https://KULLANICI.github.io/ivory/` adresinde açılır.
4. Bu adresi Spotify uygulamandaki **Redirect URIs**'e ekle ve Client ID'yi `config.js`'e yaz.

Derleme adımı yoktur; dosyalar olduğu gibi yayınlanır.

## Nasıl çalışıyor?

| Konu | Yaklaşım |
| --- | --- |
| Şarkı kaynakları | Sık dinlenenler (en çok + son çalınanlar), oyuncunun oluşturduğu çalma listeleri, kayıtlı albümler. Host hangilerinin kullanılacağını seçer. |
| Aynı şarkının farklı sürümleri | Şarkılar yalnızca Spotify kimliğiyle değil, kayıt kodu (ISRC) ve temizlenmiş “başlık + sanatçı” anahtarıyla da eşleşir. Birinde single, diğerinde albüm sürümü varsa ikisi de dinleyen sayılır. Canlı, remix, akustik gibi farklı kayıtlar ayrı tutulur. |
| Şarkının çalması | Oyuncu odaya girerken “Spotify nerede açık?” listesinden cihazını seçer; şarkılar o cihazda kendiliğinden çalar (Premium gerekir). Cihaz uykudaysa uyandırılır ve çalmanın başladığı doğrulanır; başlamazsa şarkı kendiliğinden oyun sekmesinde çalar. Cihazı olmayan “Bu sekmede çal”ı seçebilir (Premium yoksa 30 sn önizleme). |
| Oda bağlantısı | Üç ayrı genel MQTT sunucusuna aynı anda bağlanılır; biri düşse oda sürer. Mesajlar oda kodundan türetilen anahtarla şifrelenir. |
| Kopma / yenileme | Oyuncu da host da sayfayı yenileyince aynı odaya, aynı puanla döner. Host sekmesini kapatırsa oda kapanır. |
| Gizlilik | Spotify token'ı yalnızca oyuncunun tarayıcısında durur. Şarkı kimlikleri oyun için host'un tarayıcısına gider; hiçbir sunucuda saklanmaz. |

## Dosyalar

```
index.html      sayfa iskeleti
config.js       ayarlar (Client ID, oyuncu sınırı, liste adı)
css/style.css   görünüm
js/app.js       ekranlar ve etkileşimler
js/host.js      oyun motoru (şarkı seçimi, puanlama) — host'un tarayıcısında çalışır
js/client.js    odaya katılan oyuncunun tarafı
js/net.js       şifreli oda kanalı
js/mqtt.js      küçük MQTT istemcisi
js/spotify.js   Spotify girişi (PKCE), kütüphane okuma, cihazda çalma
js/audio.js     şarkıyı çalma (sekmede / cihazda)
js/lib.js       kütüphane biçimi
js/demo.js      yerel test şarkıları (yalnızca 127.0.0.1/?demo ile açılır)
```
