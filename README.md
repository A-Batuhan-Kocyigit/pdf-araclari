# PDF Araçları — Web + Android

**Site: https://abkpdf.web.app**

Masaüstü `pdf_araclari.py` uygulamasının tarayıcıda ve Android'de çalışan sürümü.
Tüm PDF işlemleri cihazın içinde (JavaScript, pdf-lib) yapılır; dosyalar hiçbir sunucuya gönderilmez.

- **Defter:** sayfaların arasına kareli / çizgili / noktalı / boş / özel PDF sayfası ekler
- **Kitapçık:** sayfaları katlanıp zımbalanacak şekilde dizer (kat çizgisi, kenar boşlukları, creep, yazıcı kalibrasyonu)
- Defteri doğrudan kitapçığa çevirme, önizleme, 26 tema, yazıcı profilleri, masaüstü `ayarlar.json` içe aktarma
- İnternetsiz çalışır (PWA), Android'de "Paylaş → PDF Araçları" ve "Birlikte aç" desteği

## Klasörler

| Yol | İçerik |
|---|---|
| `www/` | Web uygulaması (GitHub Pages'e bu klasör yayınlanır) |
| `www/js/pdfcore.js` | Defter + kitapçık algoritmaları |
| `www/js/app.js` | Arayüz |
| `android/` | Capacitor Android projesi |
| `pdf-araclari-release.jks` | APK imza anahtarı — **yedekleyin, paylaşmayın** |

## Yerelde deneme

```bash
node serve.mjs
```
Ardından tarayıcıda http://localhost:5180 adresini açın.

## APK derleme

```bash
npx cap sync android
```
Sonra `android` klasöründe (PowerShell):
```powershell
$env:JAVA_HOME="C:\Program Files\Java\jdk-24"; $env:TMP="C:\Users\Public\gradle_tmp"; $env:TEMP=$env:TMP; $env:GRADLE_OPTS="-Djavax.net.ssl.trustStoreType=Windows-ROOT -Djdk.net.unixdomain.tmpdir=C:/Users/Public/gradle_tmp"; .\gradlew.bat assembleRelease
```
Not: Kullanıcı klasörü adında Türkçe karakter olduğu için Java'ya ASCII bir geçici klasör verilir;
`Windows-ROOT` ise Java'nın Windows'un güvenilir sertifikalarını kullanmasını sağlar.
Çıktı: `android/app/build/outputs/apk/release/app-release.apk`

Güncelleme yaparken `android/app/build.gradle` içindeki `versionCode` değerini bir artırın.
Aynı imza anahtarıyla imzalanan yeni APK, telefondaki uygulamanın üzerine (ayarlar silinmeden) kurulur.

## Yayın

Ana adres **https://abkpdf.web.app** (Firebase Hosting, proje: `abkpdf`).
Yedek adres: https://a-batuhan-kocyigit.github.io/pdf-araclari/ (`gh-pages` dalı).

Web'de bir değişiklik yaptıktan sonra önce `www/sw.js` içindeki `VERSION` değerini artırın
(telefonlar yeni sürümü alsın), sonra yayınlayın (PowerShell):

```powershell
$env:NODE_EXTRA_CA_CERTS="C:\ProgramData\Avast Software\Avast\wscert.pem"; npx firebase-tools deploy --only hosting
```

Not: Avast'ın HTTPS taraması yüzünden Node.js'e Avast sertifikası gösterilir.

GitHub'a kaydetmek ve yedek adresi güncellemek için:

```bash
git push origin main
git subtree push --prefix www origin gh-pages
```
