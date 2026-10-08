-- ============================================================
-- schema.sql — โครงสร้างฐานข้อมูลตั้งต้นของระบบ Gens Karaoke (9 ตาราง)
-- ============================================================
-- ใช้ตอนตั้งค่าเครื่องใหม่ / เพื่อนในกลุ่ม clone โปรเจคไปรัน (ไฟล์นี้รวมทุก migration ใน db/migrations แล้ว
-- ไม่ต้องรัน migrations ซ้ำ) — export จาก DB ที่ใช้พัฒนาจริงด้วย pg_dump --schema-only
--
-- วิธีใช้:
--   1. สร้าง database เปล่าชื่อ gens_karaoke ใน pgAdmin (หรือ createdb gens_karaoke)
--   2. psql "$DATABASE_URL" -f db/schema.sql   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute)
--   3. เพิ่มข้อมูลร้าน / เวลาเปิด-ปิด / นโยบาย / ห้อง / บัญชีแอดมินเอง (ดู README)
--
-- หมายเหตุ: ระบบใช้ LOCALTIMESTAMP / CURRENT_DATE ของ DB เป็นเวลาไทย จึงต้องตั้ง timezone ของ
-- database เป็น Asia/Bangkok (คำสั่ง DO ด้านล่างทำให้อัตโนมัติ มีผลกับ connection ใหม่)

DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone = %L', current_database(), 'Asia/Bangkok');
END $$;

--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: booking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking (
    booking_id integer NOT NULL,
    booking_code character varying(30),
    customer_id integer,
    created_by integer,
    room_id integer NOT NULL,
    policy_id integer,
    booking_source character varying(30) DEFAULT 'customer_online'::character varying,
    booking_date date,
    start_datetime timestamp without time zone NOT NULL,
    end_datetime timestamp without time zone NOT NULL,
    guest_count integer,
    walkin_name character varying(100),
    walkin_phone character varying(20),
    note text,
    booking_status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    base_price numeric(10,2),
    peak_surcharge_total numeric(10,2) DEFAULT 0,
    price_total numeric(10,2),
    deposit_required numeric(10,2),
    deposit_status character varying(20) DEFAULT 'unpaid'::character varying,
    cancel_reason text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT booking_check CHECK ((end_datetime > start_datetime)),
    CONSTRAINT booking_check1 CHECK (((customer_id IS NOT NULL) OR (walkin_name IS NOT NULL))),
    CONSTRAINT booking_deposit_status_check CHECK (((deposit_status)::text = ANY ((ARRAY['unpaid'::character varying, 'pending_verify'::character varying, 'paid'::character varying])::text[]))),
    CONSTRAINT booking_source_check CHECK (((booking_source)::text = ANY ((ARRAY['customer_online'::character varying, 'admin_walkin'::character varying])::text[]))),
    CONSTRAINT booking_status_check CHECK (((booking_status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'cancelled'::character varying, 'completed'::character varying, 'no_show'::character varying])::text[])))
);


--
-- Name: booking_booking_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.booking_booking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: booking_booking_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.booking_booking_id_seq OWNED BY public.booking.booking_id;


--
-- Name: extension; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extension (
    extension_id integer NOT NULL,
    session_id integer NOT NULL,
    extend_minutes integer NOT NULL,
    new_end_datetime timestamp without time zone NOT NULL,
    extra_amount numeric(10,2) DEFAULT 0 NOT NULL,
    approved_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT extension_minutes_check CHECK (((extend_minutes > 0) AND ((extend_minutes % 30) = 0)))
);


--
-- Name: extension_extension_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.extension_extension_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: extension_extension_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.extension_extension_id_seq OWNED BY public.extension.extension_id;


--
-- Name: payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment (
    payment_id integer NOT NULL,
    booking_id integer NOT NULL,
    payment_type character varying(20) DEFAULT 'deposit'::character varying,
    amount numeric(10,2) NOT NULL,
    method character varying(20),
    paid_at timestamp without time zone,
    payment_status character varying(20) DEFAULT 'pending'::character varying,
    evidence_url character varying(255),
    verified_by integer,
    verified_at timestamp without time zone,
    remark text,
    CONSTRAINT payment_method_check CHECK (((method)::text = 'qrcode'::text)),
    CONSTRAINT payment_status_check CHECK (((payment_status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT payment_type_check CHECK (((payment_type)::text = 'deposit'::text))
);


--
-- Name: payment_payment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_payment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_payment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_payment_id_seq OWNED BY public.payment.payment_id;


--
-- Name: room; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room (
    room_id integer NOT NULL,
    shop_id integer,
    room_code character varying(20),
    room_name character varying(100) NOT NULL,
    size character varying(10) NOT NULL,
    capacity integer,
    price_per_hour numeric(10,2) DEFAULT 0 NOT NULL,
    room_status character varying(20) DEFAULT 'available'::character varying,
    image_url character varying(255),
    is_active boolean DEFAULT true NOT NULL,
    description text,
    theme character varying(100),
    CONSTRAINT room_size_check CHECK (((size)::text = ANY ((ARRAY['S'::character varying, 'M'::character varying, 'L'::character varying, 'XL'::character varying])::text[]))),
    CONSTRAINT room_status_check CHECK (((room_status)::text = 'available'::text))
);


--
-- Name: room_room_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.room_room_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: room_room_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.room_room_id_seq OWNED BY public.room.room_id;


--
-- Name: service_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_session (
    session_id integer NOT NULL,
    booking_id integer NOT NULL,
    checkin_time timestamp without time zone DEFAULT now() NOT NULL,
    checkout_time timestamp without time zone,
    checked_in_by integer,
    checked_out_by integer,
    session_status character varying(20) DEFAULT 'in_progress'::character varying NOT NULL,
    overtime_amount numeric(10,2) DEFAULT 0 NOT NULL,
    CONSTRAINT service_session_status_check CHECK (((session_status)::text = ANY ((ARRAY['waiting'::character varying, 'in_progress'::character varying, 'finished'::character varying])::text[])))
);


--
-- Name: service_session_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.service_session_session_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: service_session_session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.service_session_session_id_seq OWNED BY public.service_session.session_id;


--
-- Name: shop; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shop (
    shop_id integer NOT NULL,
    name character varying(150) NOT NULL,
    tax_id character varying(50),
    phone character varying(20),
    address text,
    bank_name character varying(50),
    bank_account_no character varying(30),
    bank_account_name character varying(150),
    peak_start_time time without time zone,
    peak_surcharge numeric(10,2) DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    qr_code_url text,
    floor_plan_url text
);


--
-- Name: shop_hours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shop_hours (
    shop_hours_id integer NOT NULL,
    shop_id integer NOT NULL,
    day_of_week smallint NOT NULL,
    open_hour smallint NOT NULL,
    close_hour smallint NOT NULL,
    CONSTRAINT shop_hours_close_hour_check CHECK (((close_hour >= 0) AND (close_hour <= 24))),
    CONSTRAINT shop_hours_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
    CONSTRAINT shop_hours_open_hour_check CHECK (((open_hour >= 0) AND (open_hour <= 24)))
);


--
-- Name: shop_hours_shop_hours_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shop_hours_shop_hours_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shop_hours_shop_hours_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shop_hours_shop_hours_id_seq OWNED BY public.shop_hours.shop_hours_id;


--
-- Name: shop_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shop_policy (
    policy_id integer NOT NULL,
    deposit_percent numeric(5,2) DEFAULT 20 NOT NULL,
    cancel_hours_before integer DEFAULT 1,
    allow_edit_before_hours integer,
    refund_policy_desc text,
    no_show_policy_desc text,
    effective_from timestamp without time zone DEFAULT now(),
    effective_to timestamp without time zone,
    updated_by integer
);


--
-- Name: shop_policy_policy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shop_policy_policy_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shop_policy_policy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shop_policy_policy_id_seq OWNED BY public.shop_policy.policy_id;


--
-- Name: shop_shop_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shop_shop_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shop_shop_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shop_shop_id_seq OWNED BY public.shop.shop_id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    user_id integer NOT NULL,
    name character varying(100) NOT NULL,
    phone character varying(20),
    username character varying(50),
    password_hash character varying(255),
    role character varying(20) DEFAULT 'customer'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    avatar_url text,
    CONSTRAINT users_check CHECK (((phone IS NOT NULL) OR (username IS NOT NULL))),
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['customer'::character varying, 'admin'::character varying])::text[]))),
    CONSTRAINT users_status_check CHECK (((status)::text = 'active'::text))
);


--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_user_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_user_id_seq OWNED BY public.users.user_id;


--
-- Name: booking booking_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking ALTER COLUMN booking_id SET DEFAULT nextval('public.booking_booking_id_seq'::regclass);


--
-- Name: extension extension_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension ALTER COLUMN extension_id SET DEFAULT nextval('public.extension_extension_id_seq'::regclass);


--
-- Name: payment payment_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment ALTER COLUMN payment_id SET DEFAULT nextval('public.payment_payment_id_seq'::regclass);


--
-- Name: room room_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room ALTER COLUMN room_id SET DEFAULT nextval('public.room_room_id_seq'::regclass);


--
-- Name: service_session session_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_session ALTER COLUMN session_id SET DEFAULT nextval('public.service_session_session_id_seq'::regclass);


--
-- Name: shop shop_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop ALTER COLUMN shop_id SET DEFAULT nextval('public.shop_shop_id_seq'::regclass);


--
-- Name: shop_hours shop_hours_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_hours ALTER COLUMN shop_hours_id SET DEFAULT nextval('public.shop_hours_shop_hours_id_seq'::regclass);


--
-- Name: shop_policy policy_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_policy ALTER COLUMN policy_id SET DEFAULT nextval('public.shop_policy_policy_id_seq'::regclass);


--
-- Name: users user_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN user_id SET DEFAULT nextval('public.users_user_id_seq'::regclass);


--
-- Name: booking booking_booking_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_booking_code_key UNIQUE (booking_code);


--
-- Name: booking booking_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_pkey PRIMARY KEY (booking_id);


--
-- Name: booking booking_room_id_tsrange_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_room_id_tsrange_excl EXCLUDE USING gist (room_id WITH =, tsrange(start_datetime, end_datetime) WITH &&) WHERE (((booking_status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying])::text[])));


--
-- Name: extension extension_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension
    ADD CONSTRAINT extension_pkey PRIMARY KEY (extension_id);


--
-- Name: payment payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_pkey PRIMARY KEY (payment_id);


--
-- Name: room room_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room
    ADD CONSTRAINT room_pkey PRIMARY KEY (room_id);


--
-- Name: room room_room_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room
    ADD CONSTRAINT room_room_code_key UNIQUE (room_code);


--
-- Name: service_session service_session_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_session
    ADD CONSTRAINT service_session_booking_id_key UNIQUE (booking_id);


--
-- Name: service_session service_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_session
    ADD CONSTRAINT service_session_pkey PRIMARY KEY (session_id);


--
-- Name: shop_hours shop_hours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_hours
    ADD CONSTRAINT shop_hours_pkey PRIMARY KEY (shop_hours_id);


--
-- Name: shop_hours shop_hours_shop_id_day_of_week_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_hours
    ADD CONSTRAINT shop_hours_shop_id_day_of_week_key UNIQUE (shop_id, day_of_week);


--
-- Name: shop shop_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop
    ADD CONSTRAINT shop_pkey PRIMARY KEY (shop_id);


--
-- Name: shop_policy shop_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_policy
    ADD CONSTRAINT shop_policy_pkey PRIMARY KEY (policy_id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: idx_booking_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_customer ON public.booking USING btree (customer_id);


--
-- Name: idx_booking_room_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_room_time ON public.booking USING btree (room_id, start_datetime);


--
-- Name: idx_booking_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_status ON public.booking USING btree (booking_status);


--
-- Name: booking booking_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(user_id);


--
-- Name: booking booking_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.users(user_id);


--
-- Name: booking booking_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.shop_policy(policy_id);


--
-- Name: booking booking_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking
    ADD CONSTRAINT booking_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.room(room_id);


--
-- Name: extension extension_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension
    ADD CONSTRAINT extension_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(user_id);


--
-- Name: extension extension_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension
    ADD CONSTRAINT extension_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.service_session(session_id) ON DELETE CASCADE;


--
-- Name: payment payment_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.booking(booking_id) ON DELETE CASCADE;


--
-- Name: payment payment_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(user_id);


--
-- Name: room room_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room
    ADD CONSTRAINT room_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shop(shop_id);


--
-- Name: service_session service_session_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_session
    ADD CONSTRAINT service_session_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.booking(booking_id) ON DELETE CASCADE;


--
-- Name: service_session service_session_checked_in_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_session
    ADD CONSTRAINT service_session_checked_in_by_fkey FOREIGN KEY (checked_in_by) REFERENCES public.users(user_id);


--
-- Name: service_session service_session_checked_out_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_session
    ADD CONSTRAINT service_session_checked_out_by_fkey FOREIGN KEY (checked_out_by) REFERENCES public.users(user_id);


--
-- Name: shop_hours shop_hours_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_hours
    ADD CONSTRAINT shop_hours_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shop(shop_id) ON DELETE CASCADE;


--
-- Name: shop_policy shop_policy_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_policy
    ADD CONSTRAINT shop_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(user_id);


--
-- PostgreSQL database dump complete
--


