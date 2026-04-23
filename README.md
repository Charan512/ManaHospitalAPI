# Mana Hospital - Core API (Backend)

This repository contains the Node.js/Express backend powering the Mana Hospital mobile application. It governs authentication, appointment slot limitations, and offline administrative overrides.

## Architecture & Tech Stack

- **Framework**: Express.js (Node)
- **Database**: MongoDB (Mongoose ODMs)
- **Authentication**: Firebase Admin SDK (token verification) + Custom JWT issuing.
- **Transaction Safety**: Mongoose implicit transactions ensuring concurrency safety for bookings.

## Key Logic & Route Structures

### 1. Authentication (`/api/auth`)
- Takes Firebase ID tokens, verifies them against `firebase-admin`, and maps them to a local MongoDB `User` schema.
- Issues a robust JWT dictating `admin` vs `patient` scopes.

### 2. Booking Engine (`/api/appointments`)
The core controller responsible for time and capacity management.
#### `GET /slots`
- Dynamically checks IST time offsets to calculate current occupancy metrics on a given day. Returns `{ isExpired, isFull, available }` payloads dictating what the frontend is allowed to display.

#### `POST /book` (Online Patient Booking)
- Protected by a strictly typed Mongoose `startTransaction()` session.
- Validates limits in atomic operations: 
  - **Self-Booking**: Max `1` active appointment globally.
  - **Caretaker/Family**: Max `5` active family bookings.
- Checks raw 5/5 interval occupancy thresholds.

#### `POST /offline` (Admin Walk-In Gate)
- Unlocked for authenticated Admin roles.
- Intentionally skips the `abortTransaction()` limits for full capacities allowing admins to push highly demanded slots to 6/5 or 7/5 organically. 
- Hard enforces identical chronological IST time-gates rejecting bookings placed in previously elapsed daily hours.

### 3. Patient Recovery Flow & FCM Sync
- Manages Firebase Cloud Messaging to send direct push notifications for Rejections/Missed alerts.
- Supplies `/recover` bridges mapping rejected bookings seamlessly into next available `suggest-next` time gaps.

## Running the Server Locally

```bash
npm install
npm run dev
```

*Ensure an `.env` file containing your `MONGO_URI`, `JWT_SECRET`, and `FIREBASE_ADMIN` config block is present at root.*
