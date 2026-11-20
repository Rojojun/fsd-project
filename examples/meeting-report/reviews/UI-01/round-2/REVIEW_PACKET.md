# UI-01 라운드 2 검토 패킷

기준 커밋은 `28a1d0f`이며, 아래 변경 작업본을 SHA-256으로 식별한다. 대상 과업은 HTTP 500으로 실패한 완료 요청을 같은 행에서 키보드로 재시도하는 흐름이다. 스펙과 디자인 언어는 라운드 1과 같다.

```
42fbf33bcb6c6ad408c215541b806bd2a6bb115b5eaec054eb881417f0932ab0  web/index.html
ed28f52a782e3c3137055a41fc13a7e8bfb4cbc8c3a624310771301b9a6b0623  designs/UI-01/index.html
d648b8a9a4e49feaeef79d6771226ee462c5de46ab0d8911fe3dc4365efd0038  designs/UI-01/design.json
54c8ad93e94870f66c32236b78906d4eb92cc66c9768fea33cab3383d67ba558  e2e/UI-01/complete.spec.mjs
c71ac169ede42b55459765036369bcc001c0491ce7706942697d89fe273f3a0f  e2e/UI-01/helpers.mjs
2ae4d08b640fd5d9cadd474ca6166291e0aad594c4582e4b4f978cc0ab775928  e2e/UI-01/qa-plan.json
```

A/B는 별도 세션에서 구현·시안·S-39의 변경 범위를 읽었다. 시안은 정적 산출물이며 브라우저 실행과 실제 화면 낭독의 결과는 판정 문서에 기록한다.
