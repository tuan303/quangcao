// Cấu hình đăng nhập phía trình duyệt – công khai theo thiết kế (không phải bí mật; quyền truy cập do máy chủ quyết định).
// Dự án Firebase riêng của Dashboard quảng cáo: quangcao-9a705 (không dùng chung với dự án khác).
// Không nạp Google Analytics (measurementId) – trang chỉ cần Firebase Authentication.
window.FBADS_WEB = {
  firebase: {
    apiKey: 'AIzaSyCPijcJZ62sgxRw1BpSF9fXtzD27hctX1E',
    authDomain: 'quangcao-9a705.firebaseapp.com',
    projectId: 'quangcao-9a705',
    storageBucket: 'quangcao-9a705.firebasestorage.app',
    messagingSenderId: '396687971613',
    appId: '1:396687971613:web:b086b0c8d79f84b5dd7df4'
  },
  sdk: 'https://www.gstatic.com/firebasejs/12.19.0',
  tenant: 'af9ef20a-3158-43a0-a1ab-ad72a03eb4c5', // tenant Microsoft 365 của trường (thông tin công khai)
  domain: 'hoangmaistarschool.edu.vn'
};
