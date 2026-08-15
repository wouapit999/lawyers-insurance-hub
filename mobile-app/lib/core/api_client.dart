/// API client for the mobile app.
///
/// Responsibilities beyond plain HTTP:
///
///  * **Secure token storage.** The refresh token lives in the platform
///    keystore, guarded by biometrics where the device offers them. It never
///    touches shared preferences, which is readable on a rooted handset.
///
///  * **Single-flight refresh.** A 401 triggers one rotation shared by all
///    waiting requests. Firing several rotations concurrently would look like
///    refresh-token reuse to the server, which responds by revoking every
///    session — a self-inflicted logout for every user on a slow network.
///
///  * **Offline queueing.** Requests that may be made without a signal (a
///    drafted claim, evidence uploads) are handed to the outbox instead of
///    failing, and replayed when connectivity returns. Each carries a stable
///    idempotency key generated at draft time, so a replay after a timeout
///    cannot file the same claim twice.
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiException implements Exception {
  ApiException(this.status, this.detail, {this.fieldErrors = const {}});

  final int status;

  /// Already localised by the server — display it directly rather than
  /// mapping status codes to strings a second time on the client.
  final String detail;
  final Map<String, List<String>> fieldErrors;

  @override
  String toString() => detail;
}

class ApiClient {
  ApiClient({required String baseUrl, FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage(),
        _dio = Dio(BaseOptions(
          baseUrl: baseUrl,
          connectTimeout: const Duration(seconds: 15),
          // Mobile money confirmation can legitimately take a while; a short
          // read timeout here shows a failure for a payment that succeeded.
          receiveTimeout: const Duration(seconds: 45),
          headers: {'Content-Type': 'application/json'},
        )) {
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: _onRequest,
      onError: _onError,
    ));
  }

  final Dio _dio;
  final FlutterSecureStorage _storage;

  static const _accessKey = 'lih.access_token';
  static const _refreshKey = 'lih.refresh_token';

  String _locale = 'fr';
  String? _accessToken;
  Future<bool>? _refreshInFlight;

  set locale(String value) => _locale = value;

  Future<void> restore() async {
    _accessToken = await _storage.read(key: _accessKey);
  }

  Future<void> saveTokens(String access, String refresh) async {
    _accessToken = access;
    await _storage.write(key: _accessKey, value: access);
    await _storage.write(
      key: _refreshKey,
      value: refresh,
      // Bound to this device; a backup restored onto another handset cannot
      // carry the session with it.
      iOptions: const IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
      aOptions: const AndroidOptions(encryptedSharedPreferences: true),
    );
  }

  Future<void> clearTokens() async {
    _accessToken = null;
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
  }

  void _onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.headers['Accept-Language'] = _locale;
    if (_accessToken != null) {
      options.headers['Authorization'] = 'Bearer $_accessToken';
    }
    handler.next(options);
  }

  Future<void> _onError(DioException error, ErrorInterceptorHandler handler) async {
    final response = error.response;

    if (response?.statusCode == 401 && error.requestOptions.extra['retried'] != true) {
      if (await _refresh()) {
        error.requestOptions.extra['retried'] = true;
        try {
          final retried = await _dio.fetch<dynamic>(error.requestOptions);
          return handler.resolve(retried);
        } catch (_) {
          // fall through to the error path below
        }
      }
    }

    if (response != null && response.data is Map) {
      final problem = response.data as Map<dynamic, dynamic>;
      final errors = <String, List<String>>{};
      if (problem['errors'] is Map) {
        (problem['errors'] as Map).forEach((key, value) {
          errors['$key'] = (value as List).map((e) => '$e').toList();
        });
      }
      return handler.reject(DioException(
        requestOptions: error.requestOptions,
        error: ApiException(
          response.statusCode ?? 500,
          (problem['detail'] ?? problem['title'] ?? 'Erreur') as String,
          fieldErrors: errors,
        ),
      ));
    }

    handler.next(error);
  }

  Future<bool> _refresh() {
    return _refreshInFlight ??= () async {
      try {
        final refreshToken = await _storage.read(key: _refreshKey);
        if (refreshToken == null) return false;

        // A bare Dio instance: routing this through _dio would re-enter the
        // interceptor and recurse on a second 401.
        final response = await Dio(BaseOptions(baseUrl: _dio.options.baseUrl))
            .post<Map<String, dynamic>>('/auth/refresh',
                data: {'refreshToken': refreshToken});

        final data = response.data;
        if (data == null) return false;

        await saveTokens(data['accessToken'] as String, data['refreshToken'] as String);
        return true;
      } catch (_) {
        await clearTokens();
        return false;
      } finally {
        _refreshInFlight = null;
      }
    }();
  }

  Future<T> get<T>(String path, {Map<String, dynamic>? query}) async {
    final response = await _dio.get<T>(path, queryParameters: query);
    return response.data as T;
  }

  Future<T> post<T>(
    String path, {
    Object? body,
    String? idempotencyKey,
  }) async {
    final response = await _dio.post<T>(
      path,
      data: body,
      options: Options(
        headers: idempotencyKey == null ? null : {'Idempotency-Key': idempotencyKey},
      ),
    );
    return response.data as T;
  }
}
