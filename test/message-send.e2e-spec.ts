// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { EngineRegistry } from './../src/engine/engine-registry.service';
import type { IWhatsAppEngine, MessageResult } from './../src/engine/interfaces/whatsapp-engine.interface';

/**
 * The send-* endpoints had no runtime exercise at all: the OpenAPI snapshot pins their route shape
 * but not that a POST actually reaches the engine and answers 201. These tests run the real HTTP
 * stack — guard, validation pipe, controller, MessageService (pacing gate, plugin gate, pending-row
 * persistence) — against a fake engine registered in the live EngineRegistry, so what is asserted
 * is the whole send path, not a controller mocked loose from its service.
 *
 * The fake engine is enough because everything else the path touches is real and local in this
 * harness: sqlite for the pending/sent rows, no enabled plugins, pacing disabled by default.
 * SIMULATE_TYPING is pinned off so the humanising pre-send pause doesn't slow the suite.
 */
describe('Message send endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let sessionId: string;
  let operatorKey: string;
  const prevSimulateTyping = process.env.SIMULATE_TYPING;

  const result: MessageResult = { id: 'wamid.e2e-send', timestamp: 1_706_868_000 };
  const engine = {
    sendTextMessage: jest.fn().mockResolvedValue(result),
    sendImageMessage: jest.fn().mockResolvedValue(result),
    sendVideoMessage: jest.fn().mockResolvedValue(result),
    sendAudioMessage: jest.fn().mockResolvedValue(result),
    sendDocumentMessage: jest.fn().mockResolvedValue(result),
    sendStickerMessage: jest.fn().mockResolvedValue(result),
    sendLocationMessage: jest.fn().mockResolvedValue(result),
    sendContactMessage: jest.fn().mockResolvedValue(result),
    sendPollMessage: jest.fn().mockResolvedValue(result),
  };

  const post = (verb: string, body: object, session: string = sessionId) =>
    request(app.getHttpServer())
      .post(`/api/sessions/${session}/messages/${verb}`)
      .set('X-API-Key', operatorKey)
      .send(body);

  beforeAll(async () => {
    process.env.SIMULATE_TYPING = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-send-${Date.now()}` }))).id;

    app.get(EngineRegistry).set(sessionId, engine as unknown as IWhatsAppEngine);
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-send', role: ApiKeyRole.OPERATOR })).rawKey;
  });

  afterAll(async () => {
    process.env.SIMULATE_TYPING = prevSimulateTyping;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  beforeEach(() => jest.clearAllMocks());

  it('send-text returns 201 and hands chatId + text to the engine', async () => {
    const res = await post('send-text', { chatId: '628123@c.us', text: 'hello from e2e' }).expect(201);

    expect(res.body).toEqual({ messageId: result.id, timestamp: result.timestamp });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(engine.sendTextMessage).toHaveBeenCalledWith('628123@c.us', 'hello from e2e');
  });

  it('send-image returns 201 and hands the base64 payload to the engine', async () => {
    const base64 = Buffer.from('GIF89a').toString('base64');
    const res = await post('send-image', {
      chatId: '628123@c.us',
      base64,
      mimetype: 'image/gif',
      caption: 'a gif',
    }).expect(201);

    expect(res.body).toEqual({ messageId: result.id, timestamp: result.timestamp });
    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, mimetype: 'image/gif', caption: 'a gif' }),
    );
  });

  it('send-video returns 201 and invokes the engine', async () => {
    const base64 = Buffer.from('fake-video').toString('base64');
    await post('send-video', { chatId: '628123@c.us', base64, mimetype: 'video/mp4' }).expect(201);

    expect(engine.sendVideoMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, mimetype: 'video/mp4' }),
    );
  });

  it('send-audio returns 201 and forwards the ptt flag as a voice note', async () => {
    const base64 = Buffer.from('fake-audio').toString('base64');
    await post('send-audio', { chatId: '628123@c.us', base64, mimetype: 'audio/ogg; codecs=opus', ptt: true }).expect(
      201,
    );

    expect(engine.sendAudioMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, ptt: true }),
    );
  });

  it('send-document returns 201 and keeps the filename', async () => {
    const base64 = Buffer.from('fake-pdf').toString('base64');
    await post('send-document', {
      chatId: '628123@c.us',
      base64,
      mimetype: 'application/pdf',
      filename: 'doc.pdf',
    }).expect(201);

    expect(engine.sendDocumentMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, filename: 'doc.pdf' }),
    );
  });

  it('send-location returns 201 and forwards the coordinates', async () => {
    await post('send-location', {
      chatId: '628123@c.us',
      latitude: -6.2088,
      longitude: 106.8456,
      description: 'Monas',
    }).expect(201);

    expect(engine.sendLocationMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ latitude: -6.2088, longitude: 106.8456, description: 'Monas' }),
    );
  });

  it('send-contact returns 201 and forwards the card', async () => {
    await post('send-contact', {
      chatId: '628123@c.us',
      contactName: 'Ada',
      contactNumber: '628456',
    }).expect(201);

    expect(engine.sendContactMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ name: 'Ada', number: '628456' }),
    );
  });

  it('send-poll returns 201 and forwards the question and options', async () => {
    await post('send-poll', {
      chatId: '628123@c.us',
      name: 'Lunch?',
      options: ['Nasi padang', 'Bakso'],
    }).expect(201);

    expect(engine.sendPollMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ name: 'Lunch?', options: ['Nasi padang', 'Bakso'], allowMultipleAnswers: false }),
    );
  });

  it('send-sticker returns 201 and invokes the engine', async () => {
    const base64 = Buffer.from('fake-webp').toString('base64');
    await post('send-sticker', { chatId: '628123@c.us', base64, mimetype: 'image/webp' }).expect(201);

    expect(engine.sendStickerMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, mimetype: 'image/webp' }),
    );
  });

  it('a send to a session with no live engine is a 400, not a 500', async () => {
    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    const idle = await sessionRepo.save(sessionRepo.create({ name: `e2e-send-idle-${Date.now()}` }));

    const res = await post('send-text', { chatId: '628123@c.us', text: 'hi' }, idle.id).expect(400);

    expect((res.body as { message: string }).message).toMatch(/not active/);
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });
});
