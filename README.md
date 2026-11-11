# FLL Practice Tables

Practice field reservation system for a FIRST LEGO League tournament.

## Stack
- Node.js + Express
- PostgreSQL (Railway Postgres plugin)

## Environment variables
| Name | Purpose |
|------|---------|
| `DATABASE_URL` | Set automatically by Railway when you add Postgres |
| `ADMIN_PASSWORD` | Password for the admin page at `/admin` (required) |
| `PORT` | Set automatically by Railway |

## Run locally
```
npm install
DATABASE_URL=postgres://... npm start
```
Then open http://localhost:3000. `/health` reports server and database status.
