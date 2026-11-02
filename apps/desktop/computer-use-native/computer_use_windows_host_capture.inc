bool HasGraphicsCaptureFactory() {
#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
  try {
    auto factory = winrt::get_activation_factory<
        winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
        IGraphicsCaptureItemInterop>();
    return factory != nullptr;
  } catch (...) {
    return false;
  }
#else
  return false;
#endif
}

bool CaptureWindowWithGraphicsCapture(HWND window, std::uint64_t epoch,
                                      std::uint64_t stop_serial,
                                      std::vector<std::uint8_t> *output,
                                      std::size_t *width, std::size_t *height,
                                      WindowsV1UiaStop *stop = nullptr);
bool ReadWindowsPngPatchGrid(std::vector<std::uint8_t> *png, std::size_t width,
                             std::size_t height, std::uint64_t epoch, std::uint64_t serial,
                             std::vector<std::string> *digests, std::size_t *columns,
                             std::size_t *rows, WindowsV1UiaStop *stop);
bool ReadWindowsPngPatchDigest(std::vector<std::uint8_t> *png, std::size_t width,
                               std::size_t height, double x, double y,
                               std::uint64_t epoch, std::uint64_t serial,
                               std::string *digest, std::size_t *index);

#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
bool CaptureWindowWithGraphicsCaptureOnWorker(HWND window,
                                      std::vector<std::uint8_t> *output,
                                      std::size_t *width, std::size_t *height) {
  if (!WindowsV1UiaMayCall() || window == nullptr || GetForegroundWindow() != window)
    return false;
  try {
    RECT client_bounds{};
    RECT frame_bounds{};
    if (!ClientBoundsPhysical(window, &client_bounds) ||
        FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS,
                                     &frame_bounds, sizeof(frame_bounds))) ||
        frame_bounds.right <= frame_bounds.left ||
        frame_bounds.bottom <= frame_bounds.top ||
        client_bounds.left < frame_bounds.left ||
        client_bounds.top < frame_bounds.top ||
        client_bounds.right > frame_bounds.right ||
        client_bounds.bottom > frame_bounds.bottom)
      return false;
    auto interop = winrt::get_activation_factory<
        winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
        IGraphicsCaptureItemInterop>();
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem capture_item{
        nullptr};
    if (FAILED(interop->CreateForWindow(
            window,
            winrt::guid_of<
                winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(),
            reinterpret_cast<void **>(winrt::put_abi(capture_item)))))
      return false;
    const auto source_size = capture_item.Size();
    if (source_size.Width <= 0 || source_size.Height <= 0 ||
        source_size.Width > 16'384 || source_size.Height > 16'384)
      return false;
    const double source_x_scale =
        static_cast<double>(source_size.Width) /
        static_cast<double>(frame_bounds.right - frame_bounds.left);
    const double source_y_scale =
        static_cast<double>(source_size.Height) /
        static_cast<double>(frame_bounds.bottom - frame_bounds.top);
    const auto crop_left = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.left - frame_bounds.left) * source_x_scale),
        0l, static_cast<long>(source_size.Width - 1)));
    const auto crop_top = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.top - frame_bounds.top) * source_y_scale),
        0l, static_cast<long>(source_size.Height - 1)));
    const auto crop_right = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.right - frame_bounds.left) * source_x_scale),
        static_cast<long>(crop_left + 1),
        static_cast<long>(source_size.Width)));
    const auto crop_bottom = static_cast<UINT>(std::clamp(
        std::lround((client_bounds.bottom - frame_bounds.top) * source_y_scale),
        static_cast<long>(crop_top + 1),
        static_cast<long>(source_size.Height)));
    const UINT client_width = crop_right - crop_left;
    const UINT client_height = crop_bottom - crop_top;
    constexpr double kMaximumRawCapturePixels = (7.0 * 1024.0 * 1024.0) / 4.0;
    const double byte_scale = std::sqrt(kMaximumRawCapturePixels /
                                        (static_cast<double>(client_width) *
                                         static_cast<double>(client_height)));
    const double scale = std::min(
        1.0, std::min(byte_scale,
                      std::min(2'560.0 / static_cast<double>(client_width),
                               1'600.0 / static_cast<double>(client_height))));
    const auto capture_width = static_cast<std::size_t>(
        std::max(1.0, std::floor(static_cast<double>(client_width) * scale)));
    const auto capture_height = static_cast<std::size_t>(
        std::max(1.0, std::floor(static_cast<double>(client_height) * scale)));
    if (capture_width == 0 || capture_height == 0)
      return false;

    Microsoft::WRL::ComPtr<ID3D11Device> device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL level{};
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                 D3D11_SDK_VERSION, &device, &level, &context)))
      return false;
    Microsoft::WRL::ComPtr<IDXGIDevice> dxgi_device;
    if (FAILED(device.As(&dxgi_device)))
      return false;
    winrt::com_ptr<IInspectable> inspectable_device;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(),
                                                    inspectable_device.put())))
      return false;
    auto direct3d_device = inspectable_device.as<
        winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
    const auto frame_pool =
        winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::
            CreateFreeThreaded(direct3d_device,
                               winrt::Windows::Graphics::DirectX::
                                   DirectXPixelFormat::B8G8R8A8UIntNormalized,
                               1, source_size);
    struct PoolLifetime {
      decltype(frame_pool) value;
      ~PoolLifetime() { try { value.Close(); } catch (...) {} }
    } pool_lifetime{frame_pool};
    const auto session = frame_pool.CreateCaptureSession(capture_item);
    struct SessionLifetime {
      decltype(session) value;
      ~SessionLifetime() { try { value.Close(); } catch (...) {} }
    } session_lifetime{session};
    // BEGIN windows capture event lease
    // Revocation does not wait for an asynchronous callback already in flight.
    const auto frame_event = std::make_shared<ScopedKernelHandle>();
    frame_event->value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (frame_event->value == nullptr)
      return false;
    const auto event_token = frame_pool.FrameArrived(
        [frame_event](auto const &, auto const &) { SetEvent(frame_event->value); });
    struct Subscription {
      decltype(frame_pool) pool;
      decltype(event_token) token;
      bool active = true;
      void Revoke() {
        if (!active) return;
        active = false;
        pool.FrameArrived(token);
      }
      ~Subscription() { try { Revoke(); } catch (...) {} }
    } subscription{frame_pool, event_token};
    if (!WindowsV1UiaMayCall()) return false;
    session.StartCapture();
    const auto frame_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(5'000);
    DWORD ready = WAIT_TIMEOUT;
    while (WindowsV1UiaMayCall()) {
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
          frame_deadline - std::chrono::steady_clock::now()).count();
      if (remaining <= 0) break;
      ready = WaitForSingleObject(frame_event->value,
          static_cast<DWORD>(std::min<std::int64_t>(20, remaining)));
      if (ready != WAIT_TIMEOUT) break;
    }
    subscription.Revoke();
    if (ready != WAIT_OBJECT_0 || !WindowsV1UiaMayCall())
      return false;
    // END windows capture event lease
    const auto frame = frame_pool.TryGetNextFrame();
    if (frame == nullptr)
      return false;
    struct FrameLifetime {
      decltype(frame) value;
      ~FrameLifetime() { try { value.Close(); } catch (...) {} }
    } frame_lifetime{frame};
    if (!WindowsV1UiaMayCall()) return false;
    const auto surface = frame.Surface();
    auto surface_access = surface.as<::Windows::Graphics::DirectX::Direct3D11::
                                         IDirect3DDxgiInterfaceAccess>();
    Microsoft::WRL::ComPtr<ID3D11Texture2D> source_texture;
    if (FAILED(surface_access->GetInterface(IID_PPV_ARGS(&source_texture))))
      return false;
    D3D11_TEXTURE2D_DESC source_desc{};
    source_texture->GetDesc(&source_desc);
    D3D11_TEXTURE2D_DESC staging_desc = source_desc;
    staging_desc.Width = client_width;
    staging_desc.Height = client_height;
    staging_desc.Usage = D3D11_USAGE_STAGING;
    staging_desc.BindFlags = 0;
    staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging_desc.MiscFlags = 0;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging;
    if (FAILED(device->CreateTexture2D(&staging_desc, nullptr, &staging)))
      return false;
    const D3D11_BOX client_box = {crop_left,  crop_top,    0,
                                  crop_right, crop_bottom, 1};
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0,
                                   source_texture.Get(), 0, &client_box);
    if (!WindowsV1UiaMayCall()) return false;
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)))
      return false;
    struct MappedLifetime {
      ID3D11DeviceContext *context;
      ID3D11Texture2D *texture;
      ~MappedLifetime() { context->Unmap(texture, 0); }
    } mapped_lifetime{context.Get(), staging.Get()};
    if (!WindowsV1UiaMayCall()) return false;

    Microsoft::WRL::ComPtr<IWICImagingFactory> imaging;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                                CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&imaging)))) {
      return false;
    }
    Microsoft::WRL::ComPtr<IWICBitmapEncoder> encoder;
    Microsoft::WRL::ComPtr<IWICBitmapFrameEncode> frame_encoder;
    Microsoft::WRL::ComPtr<IPropertyBag2> options;
    Microsoft::WRL::ComPtr<IWICBitmap> source_bitmap;
    Microsoft::WRL::ComPtr<IWICBitmapScaler> scaler;
    bool success = SUCCEEDED(
        imaging->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder));
    // WIC's in-memory stream encoder is intentionally kept bounded. If this
    // platform cannot encode the mapped frame, the helper reports capture
    // unavailable instead of returning raw GPU memory.
    if (success) {
      Microsoft::WRL::ComPtr<IStream> output_stream;
      success = SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &output_stream));
      if (success)
        success = SUCCEEDED(
            encoder->Initialize(output_stream.Get(), WICBitmapEncoderNoCache));
      if (success)
        success = SUCCEEDED(encoder->CreateNewFrame(&frame_encoder, &options));
      if (success)
        success = SUCCEEDED(frame_encoder->Initialize(options.Get()));
      if (success)
        success = SUCCEEDED(imaging->CreateBitmapFromMemory(
            staging_desc.Width, staging_desc.Height,
            GUID_WICPixelFormat32bppBGRA, mapped.RowPitch,
            mapped.RowPitch * staging_desc.Height,
            static_cast<BYTE *>(mapped.pData), &source_bitmap));
      IWICBitmapSource *source_to_write = source_bitmap.Get();
      if (success && (staging_desc.Width != capture_width ||
                      staging_desc.Height != capture_height)) {
        success = SUCCEEDED(imaging->CreateBitmapScaler(&scaler)) &&
                  SUCCEEDED(scaler->Initialize(
                      source_bitmap.Get(), static_cast<UINT>(capture_width),
                      static_cast<UINT>(capture_height),
                      WICBitmapInterpolationModeFant));
        source_to_write = scaler.Get();
      }
      if (success)
        success = SUCCEEDED(
            frame_encoder->SetSize(static_cast<UINT>(capture_width),
                                   static_cast<UINT>(capture_height)));
      GUID pixel_format = GUID_WICPixelFormat32bppBGRA;
      if (success)
        success = SUCCEEDED(frame_encoder->SetPixelFormat(&pixel_format));
      if (success)
        success =
            source_to_write != nullptr &&
            SUCCEEDED(frame_encoder->WriteSource(source_to_write, nullptr));
      if (success)
        success =
            SUCCEEDED(frame_encoder->Commit()) && SUCCEEDED(encoder->Commit());
      if (success) {
        STATSTG stat{};
        success = SUCCEEDED(output_stream->Stat(&stat, STATFLAG_NONAME)) &&
                  stat.cbSize.QuadPart > 0 &&
                  stat.cbSize.QuadPart <= 8ll * 1024ll * 1024ll;
        if (success) {
          LARGE_INTEGER start{};
          output_stream->Seek(start, STREAM_SEEK_SET, nullptr);
          output->resize(static_cast<std::size_t>(stat.cbSize.QuadPart));
          ULONG read = 0;
          success =
              SUCCEEDED(output_stream->Read(
                  output->data(), static_cast<ULONG>(output->size()), &read)) &&
              read == output->size();
        }
      }
    }
    if (!success || !WindowsV1UiaMayCall())
      return false;
    *width = capture_width;
    *height = capture_height;
    return !output->empty();
  } catch (...) {
    std::fill(output->begin(), output->end(), 0);
    output->clear();
    return false;
  }
}
#else
bool CaptureWindowWithGraphicsCaptureOnWorker(HWND, std::vector<std::uint8_t> *,
                                      std::size_t *, std::size_t *) {
  return false;
}
#endif

#if SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE
constexpr std::size_t kVisualPatchSize = 64;
constexpr std::size_t kMaximumVisualPatchDigests = 1'000;

bool DecodePngBgra(std::span<const std::uint8_t> png,
                   std::size_t expected_width, std::size_t expected_height,
                   std::vector<std::uint8_t> *pixels) {
  if (png.empty() || png.size() > 8 * 1024 * 1024 || expected_width == 0 ||
      expected_height == 0 || expected_width > 2'560 ||
      expected_height > 1'600 || pixels == nullptr)
    return false;
  Microsoft::WRL::ComPtr<IStream> stream;
  if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)))
    return false;
  ULONG written = 0;
  if (FAILED(stream->Write(png.data(), static_cast<ULONG>(png.size()),
                           &written)) ||
      written != static_cast<ULONG>(png.size()))
    return false;
  LARGE_INTEGER beginning{};
  if (FAILED(stream->Seek(beginning, STREAM_SEEK_SET, nullptr)))
    return false;
  Microsoft::WRL::ComPtr<IWICImagingFactory> imaging;
  Microsoft::WRL::ComPtr<IWICBitmapDecoder> decoder;
  Microsoft::WRL::ComPtr<IWICBitmapFrameDecode> frame;
  Microsoft::WRL::ComPtr<IWICFormatConverter> converter;
  if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                              CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&imaging))) ||
      FAILED(imaging->CreateDecoderFromStream(
          stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder)) ||
      FAILED(decoder->GetFrame(0, &frame)) ||
      FAILED(imaging->CreateFormatConverter(&converter)) ||
      FAILED(converter->Initialize(
          frame.Get(), GUID_WICPixelFormat32bppBGRA,
          WICBitmapDitherTypeNone, nullptr, 0.0,
          WICBitmapPaletteTypeCustom)))
    return false;
  UINT width = 0;
  UINT height = 0;
  if (FAILED(converter->GetSize(&width, &height)) ||
      width != static_cast<UINT>(expected_width) ||
      height != static_cast<UINT>(expected_height))
    return false;
  const std::size_t byte_count = expected_width * expected_height * 4;
  if (byte_count == 0 || byte_count > 8 * 1024 * 1024)
    return false;
  pixels->resize(byte_count);
  const UINT stride = width * 4;
  if (FAILED(converter->CopyPixels(
          nullptr, stride, static_cast<UINT>(pixels->size()),
          pixels->data()))) {
    std::fill(pixels->begin(), pixels->end(), 0);
    pixels->clear();
    return false;
  }
  return true;
}

bool ComputeBgraPatchDigest(std::span<const std::uint8_t> pixels,
                            std::size_t width, std::size_t height,
                            std::size_t column, std::size_t row,
                            std::string *digest) {
  const std::size_t columns = (width + kVisualPatchSize - 1) /
                              kVisualPatchSize;
  const std::size_t rows = (height + kVisualPatchSize - 1) /
                           kVisualPatchSize;
  if (digest == nullptr || width == 0 || height == 0 || column >= columns ||
      row >= rows || pixels.size() != width * height * 4)
    return false;
  const std::size_t left = column * kVisualPatchSize;
  const std::size_t top = row * kVisualPatchSize;
  const std::size_t patch_width =
      std::min(kVisualPatchSize, width - left);
  const std::size_t patch_height =
      std::min(kVisualPatchSize, height - top);
  std::vector<std::uint8_t> patch;
  patch.reserve(patch_width * patch_height * 4);
  for (std::size_t y = 0; y < patch_height; ++y) {
    const std::size_t offset = ((top + y) * width + left) * 4;
    patch.insert(patch.end(), pixels.begin() + offset,
                 pixels.begin() + offset + patch_width * 4);
  }
  std::vector<std::uint8_t> material;
  static constexpr std::string_view prefix =
      "computer-visual-patch-v1\n";
  material.reserve(prefix.size() + 32 + patch.size());
  material.insert(material.end(), prefix.begin(), prefix.end());
  const std::string dimensions =
      std::to_string(left) + "," + std::to_string(top) + "," +
      std::to_string(patch_width) + "," +
      std::to_string(patch_height) + "\n";
  material.insert(material.end(), dimensions.begin(), dimensions.end());
  material.insert(material.end(), patch.begin(), patch.end());
  *digest = Sha256Bytes(material);
  std::fill(patch.begin(), patch.end(), 0);
  std::fill(material.begin(), material.end(), 0);
  return digest->size() == 64;
}

bool VisualPatchCoordinates(std::size_t width, std::size_t height,
                            double normalized_x, double normalized_y,
                            std::size_t *column, std::size_t *row,
                            std::size_t *index) {
  if (width == 0 || height == 0 || normalized_x < 0 || normalized_x > 1 ||
      normalized_y < 0 || normalized_y > 1 || column == nullptr ||
      row == nullptr || index == nullptr)
    return false;
  const std::size_t pixel_x = static_cast<std::size_t>(std::lround(
      normalized_x * static_cast<double>(width - 1)));
  const std::size_t pixel_y = static_cast<std::size_t>(std::lround(
      normalized_y * static_cast<double>(height - 1)));
  const std::size_t columns = (width + kVisualPatchSize - 1) /
                              kVisualPatchSize;
  *column = pixel_x / kVisualPatchSize;
  *row = pixel_y / kVisualPatchSize;
  *index = *row * columns + *column;
  return true;
}

bool ComputePngPatchDigest(std::span<const std::uint8_t> png,
                           std::size_t expected_width,
                           std::size_t expected_height, double normalized_x,
                           double normalized_y, std::string *digest,
                           std::size_t *patch_index = nullptr) {
  std::vector<std::uint8_t> pixels;
  if (!DecodePngBgra(png, expected_width, expected_height, &pixels))
    return false;
  std::size_t column = 0;
  std::size_t row = 0;
  std::size_t index = 0;
  const bool located = VisualPatchCoordinates(
      expected_width, expected_height, normalized_x, normalized_y, &column,
      &row, &index);
  const bool hashed =
      located && ComputeBgraPatchDigest(pixels, expected_width,
                                       expected_height, column, row, digest);
  std::fill(pixels.begin(), pixels.end(), 0);
  if (hashed && patch_index != nullptr)
    *patch_index = index;
  return hashed;
}

bool ComputePngPatchGrid(std::span<const std::uint8_t> png,
                         std::size_t width, std::size_t height,
                         std::vector<std::string> *digests,
                         std::size_t *columns, std::size_t *rows) {
  if (digests == nullptr || columns == nullptr || rows == nullptr)
    return false;
  std::vector<std::uint8_t> pixels;
  if (!DecodePngBgra(png, width, height, &pixels))
    return false;
  *columns = (width + kVisualPatchSize - 1) / kVisualPatchSize;
  *rows = (height + kVisualPatchSize - 1) / kVisualPatchSize;
  if (*columns == 0 || *rows == 0 ||
      *columns * *rows > kMaximumVisualPatchDigests) {
    std::fill(pixels.begin(), pixels.end(), 0);
    return false;
  }
  std::vector<std::string> result;
  result.reserve(*columns * *rows);
  bool complete = true;
  for (std::size_t row = 0; complete && row < *rows; ++row) {
    for (std::size_t column = 0; column < *columns; ++column) {
      std::string digest;
      if (!ComputeBgraPatchDigest(pixels, width, height, column, row,
                                  &digest)) {
        complete = false;
        break;
      }
      result.push_back(std::move(digest));
    }
  }
  std::fill(pixels.begin(), pixels.end(), 0);
  if (!complete)
    return false;
  *digests = std::move(result);
  return true;
}

bool RevalidateVisualPatch(const WindowsSession &session, double normalized_x,
                           double normalized_y, std::string *reason) {
  if (!session.has_observation || session.active_window == nullptr ||
      session.observation_patch_digests.empty() ||
      session.observation_patch_digests.size() >
          kMaximumVisualPatchDigests ||
      session.observation_capture_width == 0 ||
      session.observation_capture_height == 0 ||
      session.observation_patch_columns == 0 ||
      session.observation_patch_rows == 0 ||
      session.observation_patch_digests.size() !=
          session.observation_patch_columns * session.observation_patch_rows) {
    *reason = "visual_observation_missing";
    return false;
  }
  std::size_t column = 0;
  std::size_t row = 0;
  std::size_t patch_index = 0;
  if (!VisualPatchCoordinates(
          session.observation_capture_width,
          session.observation_capture_height, normalized_x, normalized_y,
          &column, &row, &patch_index) ||
      patch_index >= session.observation_patch_digests.size()) {
    *reason = "visual_observation_invalid";
    return false;
  }
  std::vector<std::uint8_t> current_screenshot;
  std::size_t current_width = 0;
  std::size_t current_height = 0;
  if (!CaptureWindowWithGraphicsCapture(
          session.active_window, session.cancel_epoch, WindowsValidationFrameStopSerial(),
          &current_screenshot, &current_width,
          &current_height) ||
      current_width != session.observation_capture_width ||
      current_height != session.observation_capture_height) {
    std::fill(current_screenshot.begin(), current_screenshot.end(), 0);
    *reason = "native_visual_patch_changed";
    return false;
  }
  std::string current_digest;
  std::size_t current_patch_index = 0;
  const bool decoded = ReadWindowsPngPatchDigest(
      &current_screenshot, current_width, current_height, normalized_x,
      normalized_y, session.cancel_epoch, WindowsValidationFrameStopSerial(),
      &current_digest, &current_patch_index);
  std::fill(current_screenshot.begin(), current_screenshot.end(), 0);
  if (!decoded || current_patch_index != patch_index ||
      current_digest != session.observation_patch_digests[patch_index]) {
    *reason = "native_visual_patch_changed";
    return false;
  }
  return true;
}
#else
bool ComputePngPatchGrid(std::span<const std::uint8_t>, std::size_t,
                         std::size_t, std::vector<std::string> *,
                         std::size_t *, std::size_t *) {
  return false;
}

bool RevalidateVisualPatch(const WindowsSession &, double, double,
                           std::string *reason) {
  if (reason != nullptr)
    *reason = "graphics_capture_unavailable";
  return false;
}
#endif

