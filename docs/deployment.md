# Deployment — diplom.mn v2

Хоёр давхаргын байршуулалтын зарчим (архитектур §17):

| Давхарга | Юу | Хаана |
|---|---|---|
| **Нууц** | Postgres (PII), API, Worker, Redis, объект хадгалалт, гарын үсгийн түлхүүр | **Зөвхөн Монголд**: NDC (Tier 3) + дотоодын DR. Гадаад hosting/DR хориотой (ХМХ хууль 2022) |
| **Нээлттэй** | /verify, landing, status list mirror, did.json, нээлттэй verifier | AWS/CDN хаана ч болно |

Ачаалал (~өдөрт 55 олголт) жижиг: **Kubernetes хэрэггүй** — docker compose + 1–2 VM (нийт ~8–12 vCPU / 20–30GB RAM) хангалттай.

## Бүрдэл

- `Dockerfile` — нэг image, гурван target: `api`, `worker`, `web`
- `docker-compose.prod.yml` — бүх стек (nginx-ээс бусад нь дотоод сүлжээнд)
- `deploy/nginx/diplom.conf` — нэг домэйн: `/api/*`, `/status/*`, `/.well-known/did.json` → API; бусад нь → Web
- `.env.production.example` → `.env.production` (git-д орохгүй)
- `secrets/` — түлхүүрийн түүх + (KMS хүртэл) гарын үсгийн түлхүүр (git-д орохгүй)
- `scripts/backup.sh` — өдөр тутмын Postgres + MinIO нөөшлөлт

## Шинэ сервер дээр босгох (staging/VPS)

Шаардлага: Ubuntu 22.04+, Docker + compose plugin, 80/443 нээлттэй, DNS A бичлэг домэйн руу.

```bash
# 1. Код
git clone <REPO_URL> /opt/diplommn-v2 && cd /opt/diplommn-v2

# 2. Орчны тохиргоо
cp .env.production.example .env.production
nano .env.production        # бүх CHANGE-ME утгыг солино (openssl rand -hex 32)

# 3. Түлхүүрүүд (KMS хүртэлх шилжилтийн горим)
mkdir -p secrets
pnpm install && pnpm --filter @diplommn/did generate:dev --domain diplom.mn
cp packages/did/dev/key-history.json secrets/
cp packages/did/dev/dev-signing-key.jwk secrets/signing-key.jwk
chmod 600 secrets/*

# 4. TLS гэрчилгээ (эхний удаа — nginx асаахаас өмнө standalone)
docker compose -f docker-compose.prod.yml run --rm -p 80:80 certbot certonly \
  --standalone -d diplom.mn -d www.diplom.mn \
  --email admin@diplom.mn --agree-tos --no-eff-email

# 5. Асаах (migrate автоматаар эхэлж ажиллана)
docker compose -f docker-compose.prod.yml up -d --build

# 6. Анхны өгөгдөл (нэг л удаа)
docker compose -f docker-compose.prod.yml exec api pnpm db:seed
# → гарсан TOTP нууцуудыг authenticator-т бүртгээд энэ гаралтыг устгана

# 7. Шалгах
curl -s https://diplom.mn/api/v1/health
curl -s https://diplom.mn/.well-known/did.json | head
```

### Сертификат сунгалт (cron, сард 2 удаа)

```bash
0 3 1,15 * * cd /opt/diplommn-v2 && docker compose -f docker-compose.prod.yml run --rm certbot renew --webroot -w /var/www/certbot && docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

### Нөөшлөлт (cron, өдөр бүр)

```bash
30 2 * * * cd /opt/diplommn-v2 && ./scripts/backup.sh >> /var/log/diplommn-backup.log 2>&1
```

`BACKUP_DIR`-ийг дотоодын DR сайт руу sync хийнэ — **гадаад storage руу хэзээ ч биш**.

## Шинэчлэлт гаргах

```bash
cd /opt/diplommn-v2
git pull
BUILDX_NO_DEFAULT_ATTESTATIONS=1 \
  docker compose -f docker-compose.prod.yml up -d --build   # migrate дахин ажиллана
```

Image-ууд app тус бүрээр давхаргалагдсан тул **зөвхөн өөрчлөгдсөн service л
дахин асна**: web-ийн засвар api/worker-ийг хөндөхгүй (идэвхтэй anchor/sign
job-ууд огт тасалдахгүй). `BUILDX_NO_DEFAULT_ATTESTATIONS=1` нь build бүрд
шинэ ID үүсгэдэг attestation-ийг унтрааж, өөрчлөгдөөгүй image-ийг таньдаг
болгоно — сервер дээр `/etc/environment`-д нэг удаа бичиж болно.

## Production hardening checklist (NDC-д гарахын өмнө)

- [ ] **KMS/HSM** — `VC_SIGNING_KEY_FILE`-ийг KMS signer-ээр солих; файл дээрх түлхүүр бол шилжилтийн горим
- [ ] **HEMIS** — шинэ credentials авах (хуучин v1-ийнх задарсан, хориотой); mTLS+HMAC (D1) гэрээ
- [ ] **SMS gateway** — иргэдийн OTP (одоо SMTP/console)
- [ ] **Гэрээний аудит → Ethereum mainnet** — `ANCHOR_*`-ийг mainnet утгаар солих; gas wallet custody (#13)
- [ ] **Monitoring/alerting** — anchor batch FAILED, аудит гинжний integrity, dead-letter jobs
- [ ] **Дотоодын DR** — Postgres streaming replica эсвэл өдөр тутмын dump-ийг хоёр дахь дата төвд
- [ ] **users.totp_secret**-ийг KMS-ээр шифрлэх
- [ ] Rate limit/фаервол утгуудыг бодит ачаалалд тааруулах

## Тэмдэглэл

- Next.js build нь Google Fonts (Noto Sans)-ыг татдаг тул image build хийх орчинд гадагш сүлжээ хэрэгтэй.
- Backend TS-ээ tsx-ээр шууд ажиллуулдаг (build алхамгүй) — энэ нь зориудын сонголт; хэрэв cold-start чухал болвол build алхам нэмнэ.
- Public хуудсуудыг CDN-д тусад нь гаргах бол `apps/web`-ийг тусад нь deploy хийж, nginx-ийн web байршлыг CDN origin болгоно (stateless тул чөлөөтэй).
